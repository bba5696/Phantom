#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cdp;
mod creds;
mod settings;

use tauri::Manager;

#[tauri::command]
async fn start(
    email: String,
    password: String,
    focus_spoof: bool,
    fullscreen_spoof: bool,
    debug_mode: bool,
    app: tauri::AppHandle,
    state: tauri::State<'_, cdp::CdpState>,
) -> Result<(), String> {
    let s = state.inner().clone();
    cdp::start(s, app, email, password, focus_spoof, fullscreen_spoof, debug_mode).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn stop(
    app: tauri::AppHandle,
    state: tauri::State<'_, cdp::CdpState>,
) -> Result<(), String> {
    let s = state.inner().clone();
    cdp::stop(s, &app).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_creds() -> Result<(String, String), String> {
    creds::load().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_creds(email: String, password: String) -> Result<(), String> {
    creds::save(&email, &password).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_settings() -> Result<(bool, bool, bool), String> {
    settings::load()
        .map(|s| (s.focus_spoof, s.fullscreen_spoof, s.debug_mode))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(focus_spoof: bool, fullscreen_spoof: bool, debug_mode: bool) -> Result<(), String> {
    settings::save(&settings::Settings { focus_spoof, fullscreen_spoof, debug_mode })
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .manage(cdp::new_state())
        .invoke_handler(tauri::generate_handler![
            start, stop,
            get_creds, save_creds,
            get_settings, save_settings,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let state = window.app_handle().state::<cdp::CdpState>();
                cdp::kill_sync(&state);
            }
        })
        .run(tauri::generate_context!())
        .expect("error running Tauri app");
}
