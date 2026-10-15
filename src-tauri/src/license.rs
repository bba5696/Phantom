use std::{fs, path::PathBuf, time::Duration};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

const SERVER: &str = "https://phantommacro.app";

#[derive(Serialize, Deserialize, Default, Clone)]
struct LicenseStore {
    key: String,
    machine_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    activated_at: Option<String>,
}

#[derive(Serialize)]
struct LicenseRequest<'a> {
    key: &'a str,
    machine_id: &'a str,
}

#[derive(Deserialize)]
struct ActivateResponse {
    expires_at: Option<String>,
}

#[derive(Deserialize)]
struct ValidateResponse {
    valid: bool,
    expires_at: Option<String>,
    email: Option<String>,
}

/// Returned by `check_license` and consumed by the frontend.
#[derive(Serialize, Clone, Default)]
pub struct LicenseInfo {
    pub valid: bool,
    pub key: String,
    pub expires_at: Option<String>,
    pub email: Option<String>,
    /// ISO-8601 timestamp of first activation; used for the expiry progress bar.
    pub activated_at: Option<String>,
}

fn store_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Phantom")
        .join("license.json")
}

fn load_store() -> LicenseStore {
    let path = store_path();
    if !path.exists() { return LicenseStore::default(); }
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<LicenseStore>(&s).ok())
        .unwrap_or_default()
}

fn save_store(store: &LicenseStore) -> Result<()> {
    let path = store_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, serde_json::to_string_pretty(store)?)?;
    Ok(())
}

fn ensure_machine_id(store: &mut LicenseStore) -> String {
    if store.machine_id.is_empty() {
        store.machine_id = uuid::Uuid::new_v4().to_string();
        let _ = save_store(store);
    }
    store.machine_id.clone()
}

fn now_rfc3339() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as RFC-3339 / ISO-8601 UTC: YYYY-MM-DDTHH:MM:SSZ
    let s = secs % 60;
    let m = (secs / 60) % 60;
    let h = (secs / 3600) % 24;
    let days = secs / 86400;
    // Days since Unix epoch → Gregorian date (works until 2100)
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let yr = if mo <= 2 { y + 1 } else { y };
    format!("{yr:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .expect("reqwest client")
}

fn info_from_store(store: &LicenseStore, valid: bool) -> LicenseInfo {
    LicenseInfo {
        valid,
        key: store.key.clone(),
        expires_at: store.expires_at.clone(),
        email: store.email.clone(),
        activated_at: store.activated_at.clone(),
    }
}

/// Called on every app start. Falls back to local store if server is unreachable.
pub async fn check() -> LicenseInfo {
    let mut store = load_store();
    if store.key.is_empty() {
        return LicenseInfo::default();
    }
    let machine_id = ensure_machine_id(&mut store);

    let res = client()
        .post(format!("{SERVER}/validate"))
        .json(&LicenseRequest { key: &store.key, machine_id: &machine_id })
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            match r.json::<ValidateResponse>().await {
                Ok(v) if v.valid => {
                    // Refresh cached expiry and email from server.
                    if v.expires_at.is_some() { store.expires_at = v.expires_at; }
                    if v.email.is_some() { store.email = v.email; }
                    let _ = save_store(&store);
                    info_from_store(&store, true)
                }
                Ok(_) => info_from_store(&store, false),
                Err(_) => info_from_store(&store, false),
            }
        }
        // Server unreachable — trust local store.
        Err(_) => info_from_store(&store, true),
        _ => info_from_store(&store, false),
    }
}

/// Activates the key on this machine and stores the result locally.
pub async fn activate(key: &str) -> Result<Option<String>> {
    let clean = key.replace('-', "");
    if clean.len() != 16 {
        bail!("Invalid license key format.");
    }

    let mut store = load_store();
    let machine_id = ensure_machine_id(&mut store);

    let res = client()
        .post(format!("{SERVER}/activate"))
        .json(&LicenseRequest { key, machine_id: &machine_id })
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("Could not reach the license server. Check your connection."))?;

    if !res.status().is_success() {
        let msg = res.text().await.unwrap_or_else(|_| "Activation failed.".into());
        let display = serde_json::from_str::<serde_json::Value>(&msg)
            .ok()
            .and_then(|v| v["message"].as_str().map(ToOwned::to_owned))
            .unwrap_or(msg);
        bail!("{}", display);
    }

    let data: ActivateResponse = res.json().await
        .map_err(|_| anyhow::anyhow!("Unexpected server response."))?;

    store.key = key.to_owned();
    store.expires_at = data.expires_at.clone();
    store.activated_at = Some(now_rfc3339());
    save_store(&store)?;

    Ok(data.expires_at)
}

/// Frees the seat on the server then removes the local store.
pub async fn deactivate() -> Result<()> {
    let store = load_store();

    if !store.key.is_empty() && !store.machine_id.is_empty() {
        let _ = client()
            .post(format!("{SERVER}/deactivate"))
            .json(&LicenseRequest { key: &store.key, machine_id: &store.machine_id })
            .send()
            .await;
    }

    let path = store_path();
    if path.exists() { fs::remove_file(path)?; }
    Ok(())
}
