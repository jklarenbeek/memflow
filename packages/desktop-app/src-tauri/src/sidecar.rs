//! MemFlow Sidecar Manager
//!
//! Manages the lifecycle of the MemFlow Bun backend process:
//! - Port auto-detection (scan 3000-3099)
//! - Health check polling
//! - Graceful shutdown
//! - Crash restart with exponential backoff

use std::net::TcpListener;
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

/// Connection mode for the MemFlow backend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionMode {
    /// App manages the Bun process as a sidecar
    EmbeddedSidecar,
    /// User-configured URL to an external MemFlow server
    ExternalServer(String),
}

/// Sidecar state managed by Tauri
pub struct SidecarState {
    pub port: Mutex<u16>,
    pub mode: Mutex<ConnectionMode>,
    pub server_url: Mutex<String>,
    pub is_healthy: Mutex<bool>,
    pub restart_count: Mutex<u32>,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            port: Mutex::new(3000),
            mode: Mutex::new(ConnectionMode::EmbeddedSidecar),
            server_url: Mutex::new("http://127.0.0.1:3000".to_string()),
            is_healthy: Mutex::new(false),
            restart_count: Mutex::new(0),
        }
    }
}

/// Find an available port in the range 3000-3099
pub fn find_available_port() -> Option<u16> {
    for port in 3000..3100 {
        if TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Health check response shape
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
}

/// Tauri command: Get the current server URL
#[tauri::command]
pub fn get_server_url(state: tauri::State<SidecarState>) -> String {
    state.server_url.lock().unwrap().clone()
}

/// Tauri command: Get sidecar health status
#[tauri::command]
pub fn get_sidecar_status(state: tauri::State<SidecarState>) -> serde_json::Value {
    let is_healthy = *state.is_healthy.lock().unwrap();
    let port = *state.port.lock().unwrap();
    let mode = state.mode.lock().unwrap().clone();
    let restart_count = *state.restart_count.lock().unwrap();

    serde_json::json!({
        "healthy": is_healthy,
        "port": port,
        "mode": format!("{:?}", mode),
        "restartCount": restart_count,
        "serverUrl": *state.server_url.lock().unwrap(),
    })
}

/// Tauri command: Set connection to external server
#[tauri::command]
pub fn set_external_server(url: String, state: tauri::State<SidecarState>) -> bool {
    *state.mode.lock().unwrap() = ConnectionMode::ExternalServer(url.clone());
    *state.server_url.lock().unwrap() = url;
    true
}

/// Tauri command: Check if a URL is reachable (health endpoint)
#[tauri::command]
pub async fn check_health(url: String) -> Result<HealthResponse, String> {
    let health_url = format!("{}/health", url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&health_url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    resp.json::<HealthResponse>()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}
