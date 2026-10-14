use std::{
    path::PathBuf,
    process::{Child, Command},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::{net::TcpStream, time::sleep};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

const SPOOF_JS: &str = include_str!("../resources/ep-spoof.js");
const MACRO_JS: &str = include_str!("../resources/ep-macro.js");

// ── Types ─────────────────────────────────────────────────────────────────────

type WsSink   = futures_util::stream::SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = futures_util::stream::SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

struct CdpHandle {
    child:     Option<Child>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct CdpState(Arc<Mutex<Option<CdpHandle>>>);

pub fn new_state() -> CdpState {
    CdpState(Arc::new(Mutex::new(None)))
}

enum SessionResult {
    UserStopped,
    Disconnected,
}

// ── Chrome discovery ──────────────────────────────────────────────────────────

fn find_chrome() -> Option<PathBuf> {
    let local  = std::env::var("LOCALAPPDATA").unwrap_or_default();
    let prog   = std::env::var("PROGRAMFILES").unwrap_or_default();
    let prog86 = std::env::var("PROGRAMFILES(X86)").unwrap_or_default();
    [
        format!(r"{local}\Google\Chrome\Application\chrome.exe"),
        format!(r"{prog}\Google\Chrome\Application\chrome.exe"),
        format!(r"{prog86}\Google\Chrome\Application\chrome.exe"),
        format!(r"{local}\BraveSoftware\Brave-Browser\Application\brave.exe"),
        format!(r"{prog}\BraveSoftware\Brave-Browser\Application\brave.exe"),
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|p| p.exists())
}

async fn cdp_port_open() -> bool {
    let Ok(client) = reqwest::Client::builder()
        .timeout(Duration::from_millis(400))
        .build()
    else {
        return false;
    };
    client.get("http://localhost:9222/json").send().await.is_ok()
}

// ── Public API ────────────────────────────────────────────────────────────────

pub async fn start(state: CdpState, app: AppHandle, email: String, password: String, focus_spoof: bool, fullscreen_spoof: bool, debug_mode: bool) -> Result<()> {
    // Cancel + kill any existing session
    {
        let mut guard = state.0.lock().unwrap();
        if let Some(ref mut h) = *guard {
            h.cancelled.store(true, Ordering::Relaxed);
            if let Some(mut c) = h.child.take() { let _ = c.kill(); }
        }
        *guard = None;
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    emit_status(&app, "Connecting…", "warning");

    // ── Step 1: find or launch Chrome ──────────────────────────────────────────
    let child = if cdp_port_open().await {
        // Chrome (or another DevTools-enabled browser) already has port 9222 open
        emit_log(&app, "Attached to existing Chrome/Brave session", "dim");
        None
    } else {
        let chrome = find_chrome().ok_or_else(|| {
            anyhow!("Chrome or Brave not found — install either browser")
        })?;
        // Chrome requires --user-data-dir when remote debugging is enabled,
        // otherwise it refuses to start with "requires a non-default data directory".
        let profile_dir = dirs::data_local_dir()
            .unwrap_or_else(|| std::path::PathBuf::from("."))
            .join("Phantom")
            .join("chrome-profile");
        let profile_arg = format!("--user-data-dir={}", profile_dir.display());

        let c = Command::new(&chrome)
            .args([
                "--remote-debugging-port=9222",
                "--no-first-run",
                "--no-default-browser-check",
                &profile_arg,
                "https://app.educationperfect.com",
            ])
            .spawn()?;
        emit_log(&app, &format!("Launched {}", chrome.file_name().unwrap_or_default().to_string_lossy()), "dim");
        Some(c)
    };

    // Store the handle immediately so stop() can cancel even mid-connect
    {
        let mut guard = state.0.lock().unwrap();
        *guard = Some(CdpHandle { child, cancelled: cancelled.clone() });
    }

    // ── Step 2: wait for EP tab with live feedback ──────────────────────────────
    let ws_url = match wait_for_ep_tab(&app, &cancelled, &email, &password).await {
        Ok(url) => url,
        Err(e) => {
            kill_and_clear(&state);
            emit_status(&app, "Error", "error");
            return Err(e);
        }
    };

    // ── Step 3: connect WebSocket + inject macro ────────────────────────────────
    let (initial_sink, initial_stream) = match open_and_inject(&ws_url, &app, focus_spoof, fullscreen_spoof, debug_mode).await {
        Ok(conn) => conn,
        Err(e) => {
            kill_and_clear(&state);
            emit_status(&app, "Error", "error");
            return Err(e);
        }
    };

    emit_log(&app, "Phantom active", "good");
    emit_status(&app, "Running", "running");

    // ── Step 4: event loop with auto-reconnect ──────────────────────────────────
    let app2       = app.clone();
    let cancelled2 = cancelled.clone();
    let state2     = state.clone();

    tauri::async_runtime::spawn(async move {
        let mut _sink  = initial_sink;  // kept alive so Chrome doesn't see a half-closed WS
        let mut stream = initial_stream;

        'outer: loop {
            match run_session(&mut stream, &app2, &cancelled2).await {
                SessionResult::UserStopped => break 'outer,

                SessionResult::Disconnected => {
                    emit_log(&app2, "EP tab disconnected", "warn");
                    emit_status(&app2, "Reconnecting…", "warning");

                    let mut reconnected = false;

                    for attempt in 1u32..=5 {
                        sleep(Duration::from_secs(3)).await;

                        if cancelled2.load(Ordering::Relaxed) {
                            break 'outer;
                        }

                        emit_log(&app2, &format!("Reconnect {attempt}/5…"), "dim");

                        match find_ep_tab_url().await {
                            Err(_) => {
                                // EP tab not found yet — tell user on first miss only
                                if attempt == 1 {
                                    emit_log(&app2, "EP tab not found — re-open Education Perfect to reconnect", "warn");
                                }
                            }
                            Ok(new_url) => match open_and_inject(&new_url, &app2, focus_spoof, fullscreen_spoof, debug_mode).await {
                                Ok((new_sink, new_stream)) => {
                                    _sink  = new_sink;
                                    stream = new_stream;
                                    reconnected = true;
                                    emit_log(&app2, "Reconnected to EP tab", "good");
                                    emit_status(&app2, "Running", "running");
                                    break;
                                }
                                Err(e) => emit_log(&app2, &format!("Reconnect error: {e}"), "dim"),
                            },
                        }
                    }

                    if !reconnected {
                        emit_log(&app2, "Could not reconnect after 5 attempts — relaunch Phantom", "error");
                        emit_status(&app2, "Idle", "idle");
                        break 'outer;
                    }
                }
            }
        }

        // Cleanup child process on task exit
        let mut guard = state2.0.lock().unwrap();
        if let Some(ref mut h) = *guard {
            if let Some(mut c) = h.child.take() { let _ = c.kill(); }
        }
        *guard = None;
    });

    Ok(())
}

/// Synchronous kill called from the window-close event handler (no async runtime available).
pub fn kill_sync(state: &CdpState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut h) = *guard {
        h.cancelled.store(true, Ordering::Relaxed);
        if let Some(mut c) = h.child.take() { let _ = c.kill(); }
    }
    *guard = None;
}

pub async fn stop(state: CdpState, app: &AppHandle) -> Result<()> {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut h) = *guard {
        h.cancelled.store(true, Ordering::Relaxed);
        if let Some(mut c) = h.child.take() { let _ = c.kill(); }
    }
    *guard = None;
    emit_status(app, "Idle", "idle");
    emit_log(app, "Stopped.", "dim");
    Ok(())
}

// ── Internal helpers ──────────────────────────────────────────────────────────

fn kill_and_clear(state: &CdpState) {
    let mut guard = state.0.lock().unwrap();
    if let Some(ref mut h) = *guard {
        if let Some(mut c) = h.child.take() { let _ = c.kill(); }
    }
    *guard = None;
}

/// Poll until an EP app tab is ready. Detects the IAM login page and auto-fills
/// credentials if they are provided. Respects the cancelled flag.
async fn wait_for_ep_tab(app: &AppHandle, cancelled: &AtomicBool, email: &str, password: &str) -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;

    let mut chrome_up       = false;
    let mut last_reminder   = 0u32;
    let mut tried_login     = false;
    // Once the IAM login page is seen, accept app.educationperfect.com immediately.
    // Without this flag we require 3 consecutive polls to guard against the race
    // where Chrome briefly shows app.educationperfect.com before redirecting to IAM.
    let mut seen_iam        = false;
    let mut ep_stable_count = 0u32;
    let mut last_ep_ws      = String::new();

    for i in 0u32..120 { // max 60 s (login takes time)
        sleep(Duration::from_millis(500)).await;

        if cancelled.load(Ordering::Relaxed) {
            return Err(anyhow!("Cancelled"));
        }

        match client.get("http://localhost:9222/json").send().await {
            Err(_) => {
                if i == 20 {
                    return Err(anyhow!(
                        "Chrome not responding after 10 s — is port 9222 blocked by another app?"
                    ));
                }
                continue;
            }

            Ok(resp) => {
                let Ok(targets) = resp.json::<Vec<Value>>().await else { continue };

                if !chrome_up {
                    chrome_up = true;
                    emit_status(app, "Waiting for EP…", "warning");
                }

                // ── Auto-login on IAM page ──────────────────────────────────────
                if !tried_login && !email.is_empty() && !password.is_empty() {
                    if let Some(login_ws) = targets.iter()
                        .find(|t| t["url"].as_str()
                            .map(|u| u.contains("iam.educationperfect.com"))
                            .unwrap_or(false))
                        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
                    {
                        tried_login = true;
                        seen_iam = true;
                        ep_stable_count = 0;
                        last_ep_ws.clear();
                        emit_log(app, "Login page detected — filling credentials…", "dim");
                        try_autologin(login_ws, email, password).await;
                        emit_status(app, "Logging in…", "warning");
                        continue; // give the redirect a moment
                    }
                }

                // ── Look for the EP app tab (post-login) ───────────────────────
                let ep_ws = targets.iter()
                    .find(|t| t["url"].as_str()
                        .map(|u| u.contains("app.educationperfect.com"))
                        .unwrap_or(false))
                    .and_then(|t| t["webSocketDebuggerUrl"].as_str())
                    .map(ToOwned::to_owned);

                if let Some(ws) = ep_ws {
                    // Guard against the race condition where Chrome opens
                    // app.educationperfect.com and immediately redirects to IAM:
                    // require 3 consecutive polls at the same URL (~1.5 s) unless
                    // we already know the login page was shown and dismissed.
                    if ws == last_ep_ws {
                        ep_stable_count += 1;
                    } else {
                        ep_stable_count = 1;
                        last_ep_ws = ws.clone();
                    }

                    if seen_iam || ep_stable_count >= 3 {
                        return Ok(ws);
                    }
                    // Tab just appeared — might be pre-redirect, keep waiting
                } else {
                    ep_stable_count = 0;
                    last_ep_ws.clear();
                }

                if chrome_up && i.saturating_sub(last_reminder) >= 20 && i > 0 {
                    last_reminder = i;
                    emit_log(app, "Still waiting for EP tab…", "dim");
                }
            }
        }
    }

    Err(anyhow!("Timed out (60 s) — navigate to Education Perfect and relaunch"))
}

/// Connect to the IAM login tab and fill credentials, then close the CDP session.
async fn try_autologin(ws_url: &str, email: &str, password: &str) {
    let Ok((ws, _)) = connect_async(ws_url).await else { return };
    let (mut sink, _stream) = ws.split();

    // Give the page time to finish rendering the form (more than 800ms because
    // Chrome may still be starting up when the IAM tab first appears in /json)
    sleep(Duration::from_millis(1500)).await;

    let email_json    = serde_json::to_string(email).unwrap_or_default();
    let password_json = serde_json::to_string(password).unwrap_or_default();

    // Use the native value setter so React/Angular interceptors don't block the fill
    let js = format!(r#"(function(){{
        function fill(el, v){{
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')
                  .set.call(el, v);
            el.dispatchEvent(new Event('input',  {{bubbles:true}}));
            el.dispatchEvent(new Event('change', {{bubbles:true}}));
        }}
        var u = document.getElementById('loginId');
        var p = document.getElementById('password');
        var b = document.querySelector('.btn-login');
        if (u && p && b) {{ fill(u, {}); fill(p, {}); b.click(); }}
    }})()"#, email_json, password_json);

    let _ = sink.send(Message::Text(
        json!({"id": 1, "method": "Runtime.enable"}).to_string()
    )).await;
    let _ = sink.send(Message::Text(
        json!({"id": 2, "method": "Runtime.evaluate", "params": {"expression": js}}).to_string()
    )).await;

    // Brief pause so the WS frame is flushed before we drop the connection
    sleep(Duration::from_millis(300)).await;
}

/// Quick one-shot lookup used during reconnect attempts.
async fn find_ep_tab_url() -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()?;
    let targets = client
        .get("http://localhost:9222/json")
        .send()
        .await?
        .json::<Vec<Value>>()
        .await?;
    // Only match the app tab, not the IAM login page
    targets.iter()
        .find(|t| t["url"].as_str().map(|u| u.contains("app.educationperfect.com")).unwrap_or(false))
        .and_then(|t| t["webSocketDebuggerUrl"].as_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("EP tab not found"))
}

/// Connect WebSocket + inject the macro. Returns (sink, stream) on success.
async fn open_and_inject(ws_url: &str, app: &AppHandle, focus_spoof: bool, fullscreen_spoof: bool, debug_mode: bool) -> Result<(WsSink, WsStream)> {
    let (ws, _) = connect_async(ws_url).await
        .map_err(|e| anyhow!("WebSocket connect failed: {e}"))?;
    let (mut sink, stream) = ws.split();

    // Inject settings object first so the macro can read them synchronously
    let settings_js = format!(
        "window.__phantomSettings = {{ focusSpoof: {}, fullscreenSpoof: {}, debugMode: {} }};",
        focus_spoof, fullscreen_spoof, debug_mode
    );

    // settings → spoof patches → macro (order matters: spoof must run before EP's scripts)
    let full_source = format!("{settings_js}\n{SPOOF_JS}\n{MACRO_JS}");

    for cmd in [
        json!({ "id": 1, "method": "Runtime.enable" }),
        json!({ "id": 2, "method": "Page.enable" }),
        json!({
            "id": 3,
            "method": "Page.addScriptToEvaluateOnNewDocument",
            "params": { "source": &full_source }
        }),
        json!({
            "id": 4,
            "method": "Runtime.evaluate",
            "params": { "expression": &full_source, "awaitPromise": false }
        }),
    ] {
        sink.send(Message::Text(cmd.to_string())).await
            .map_err(|e| anyhow!("CDP send failed: {e}"))?;
    }

    emit_log(app, "Macro injected", "dim");
    Ok((sink, stream))
}

/// Drive a live WS session. Returns when the tab closes or the user cancels.
/// Uses a 600 ms read timeout so `cancelled` is checked frequently even when
/// Chrome sends no messages.
async fn run_session(
    stream:    &mut WsStream,
    app:       &AppHandle,
    cancelled: &AtomicBool,
) -> SessionResult {
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return SessionResult::UserStopped;
        }

        match tokio::time::timeout(Duration::from_millis(600), stream.next()).await {
            // Normal log/event message
            Ok(Some(Ok(Message::Text(text)))) => handle_event(&text, app),

            // Tab closed gracefully
            Ok(Some(Ok(Message::Close(_)))) => {
                emit_log(app, "EP tab was closed", "warn");
                return SessionResult::Disconnected;
            }

            // Stream ended (Chrome crashed or killed)
            Ok(None) => {
                emit_log(app, "Chrome closed unexpectedly", "warn");
                return SessionResult::Disconnected;
            }

            // WebSocket-level error
            Ok(Some(Err(e))) => {
                emit_log(app, &format!("WebSocket error: {e}"), "error");
                return SessionResult::Disconnected;
            }

            // Read timed out — no message this tick, just loop and check cancelled
            Err(_timeout) => {}

            // Ping / pong / binary — handled internally by tungstenite
            Ok(Some(Ok(_))) => {}
        }
    }
}

// ── Event parsing ─────────────────────────────────────────────────────────────

fn handle_event(text: &str, app: &AppHandle) {
    let Ok(val) = serde_json::from_str::<Value>(text) else { return };
    if val["method"] != "Runtime.consoleAPICalled" { return; }
    let Some(args) = val["params"]["args"].as_array() else { return };

    let parts: Vec<&str> = args.iter()
        .filter_map(|a| a["value"].as_str())
        .collect();

    // Phantom macro: console.log('[Phantom]', message, '#colorhex')
    if parts.first().copied() != Some("[Phantom]") { return; }
    let msg   = parts.get(1).copied().unwrap_or("");
    let color = parts.get(2).copied().unwrap_or("#94a3b8");
    emit_log(app, msg, css_to_class(color));
}

fn css_to_class(css: &str) -> &'static str {
    let c = css.trim_start_matches('#').to_lowercase();
    if      c.starts_with("4f") || c.starts_with("0f") || c.starts_with("10") { "good"  }
    else if c.starts_with("ef") || c.starts_with("f44") || c.starts_with("e44") { "error" }
    else if c.starts_with("f5") || c.starts_with("fa") || c.starts_with("fb")  { "warn"  }
    else { "info" }
}

fn emit_log(app: &AppHandle, msg: &str, color: &str) {
    let _ = app.emit("log", json!({ "msg": msg, "color": color }));
}

fn emit_status(app: &AppHandle, label: &str, state: &str) {
    let _ = app.emit("status", json!({ "label": label, "state": state }));
}
