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

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .expect("reqwest client")
}

/// Called on every app start. Falls back to local if server is unreachable.
pub async fn check() -> bool {
    let mut store = load_store();
    if store.key.is_empty() { return false; }
    let machine_id = ensure_machine_id(&mut store);

    let res = client()
        .post(format!("{SERVER}/validate"))
        .json(&LicenseRequest { key: &store.key, machine_id: &machine_id })
        .send()
        .await;

    match res {
        Ok(r) if r.status().is_success() => {
            r.json::<ValidateResponse>().await.map(|v| v.valid).unwrap_or(false)
        }
        Err(_) => true, // server unreachable — trust local store
        _ => false,
    }
}

/// Validates with the server and saves the key+machine_id locally on success.
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
        // Try to extract a human-readable message from JSON error responses
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
