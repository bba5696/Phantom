use std::{fs, path::PathBuf};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct Settings {
    #[serde(default = "default_true")]
    pub focus_spoof: bool,
    #[serde(default = "default_true")]
    pub fullscreen_spoof: bool,
    #[serde(default)]
    pub debug_mode: bool,
}

fn default_true() -> bool { true }

impl Default for Settings {
    fn default() -> Self {
        Self { focus_spoof: true, fullscreen_spoof: true, debug_mode: false }
    }
}

fn path() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Phantom")
        .join("settings.json")
}

pub fn load() -> anyhow::Result<Settings> {
    let p = path();
    if !p.exists() { return Ok(Settings::default()); }
    Ok(serde_json::from_str(&fs::read_to_string(p)?).unwrap_or_default())
}

pub fn save(s: &Settings) -> anyhow::Result<()> {
    let p = path();
    if let Some(parent) = p.parent() { fs::create_dir_all(parent)?; }
    fs::write(&p, serde_json::to_string_pretty(s)?)?;
    Ok(())
}
