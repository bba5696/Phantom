use std::{fs, path::PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Default)]
struct Creds {
    email: String,
    password: String,
}

fn creds_path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Phantom")
        .join("creds.json")
}

pub fn load() -> anyhow::Result<(String, String)> {
    let path = creds_path();
    if !path.exists() {
        return Ok((String::new(), String::new()));
    }
    let json = fs::read_to_string(&path)?;
    let c: Creds = serde_json::from_str(&json)?;
    Ok((c.email, c.password))
}

pub fn save(email: &str, password: &str) -> anyhow::Result<()> {
    let path = creds_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let c = Creds {
        email: email.to_owned(),
        password: password.to_owned(),
    };
    fs::write(&path, serde_json::to_string_pretty(&c)?)?;
    Ok(())
}
