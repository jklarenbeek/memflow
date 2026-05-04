//! MemFlow Sidecar Manager
//!
//! Manages the lifecycle of the MemFlow Bun backend process:
//! - Repo root auto-detection (walk up from exe, or MEMFLOW_ROOT env)
//! - Port auto-detection (scan 3000-3099)
//! - Health check polling (GET /health every 5s)
//! - Graceful shutdown (kill process tree on Windows)
//! - Crash restart with exponential backoff (1s, 2s, 4s, max 30s, max 5 attempts)

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

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
    pub child: Mutex<Option<Child>>,
    pub memflow_root: Mutex<Option<PathBuf>>,
    pub max_restarts: u32,
}

impl Default for SidecarState {
    fn default() -> Self {
        Self {
            port: Mutex::new(3000),
            mode: Mutex::new(ConnectionMode::EmbeddedSidecar),
            server_url: Mutex::new("http://127.0.0.1:3000".to_string()),
            is_healthy: Mutex::new(false),
            restart_count: Mutex::new(0),
            child: Mutex::new(None),
            memflow_root: Mutex::new(None),
            max_restarts: 5,
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

/// Detect the memflow repo root by walking up from the executable path.
/// Looks for a package.json containing "memflow" as the name field.
/// Falls back to MEMFLOW_ROOT environment variable.
pub fn detect_memflow_root() -> Option<PathBuf> {
    // Priority 1: MEMFLOW_ROOT environment variable
    if let Ok(root) = std::env::var("MEMFLOW_ROOT") {
        let path = PathBuf::from(&root);
        if path.join("package.json").exists() && path.join("src").join("server").exists() {
            log::info!("Memflow root from MEMFLOW_ROOT env: {}", path.display());
            return Some(path);
        }
        log::warn!(
            "MEMFLOW_ROOT={} set but doesn't look like a memflow repo, falling back to path walk",
            root
        );
    }

    // Priority 2: Walk up from the current executable
    if let Ok(exe_path) = std::env::current_exe() {
        let mut current = exe_path.parent().map(|p| p.to_path_buf());
        // Walk up at most 10 levels
        for _ in 0..10 {
            if let Some(ref dir) = current {
                let pkg_json = dir.join("package.json");
                if pkg_json.exists() {
                    // Quick check: does this look like the memflow root?
                    if let Ok(content) = std::fs::read_to_string(&pkg_json) {
                        if content.contains("\"name\": \"memflow\"")
                            || content.contains("\"name\":\"memflow\"")
                        {
                            log::info!("Memflow root detected at: {}", dir.display());
                            return Some(dir.clone());
                        }
                    }
                }
                current = dir.parent().map(|p| p.to_path_buf());
            } else {
                break;
            }
        }
    }

    log::error!("Could not detect memflow repo root. Set MEMFLOW_ROOT environment variable.");
    None
}

/// Health check response shape
#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct HealthResponse {
    pub status: String,
    pub service: String,
    pub version: String,
}

/// Check if a URL is reachable by hitting its /health endpoint.
async fn check_health_internal(base_url: &str) -> Result<HealthResponse, String> {
    let health_url = format!("{}/health", base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .get(&health_url)
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    resp.json::<HealthResponse>()
        .await
        .map_err(|e| format!("Invalid response: {}", e))
}

/// Start the MemFlow Bun backend as a child process.
///
/// On Windows, uses CREATE_NEW_PROCESS_GROUP for proper cleanup.
/// In debug builds, runs `bun --watch src/index.ts` (hot reload).
/// In release builds, runs `bun src/index.ts` (no watch).
fn spawn_bun_process(memflow_root: &PathBuf, port: u16) -> Result<Child, String> {
    let mut cmd = std::process::Command::new("bun");

    // Debug vs release: use --watch in dev mode
    if cfg!(debug_assertions) {
        cmd.arg("--watch");
    }

    cmd.arg("src/index.ts");

    // Set the working directory to the memflow repo root
    cmd.current_dir(memflow_root);

    // Set PORT environment variable
    cmd.env("PORT", port.to_string());

    // Ensure localhost-only binding
    cmd.env("HOST", "127.0.0.1");

    // Pipe stdout and stderr so we can log them
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    // Windows-specific: create new process group for clean termination
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP = 0x00000200
        cmd.creation_flags(0x00000200);
    }

    // Unix-specific: create new process group via setsid
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "Bun not found in PATH. Install Bun (https://bun.sh) or set MEMFLOW_ROOT to point to the repo.".to_string()
        } else {
            format!("Failed to start Bun process: {}", e)
        }
    })?;

    log::info!(
        "Bun sidecar started (PID: {}, port: {}, dir: {})",
        child.id(),
        port,
        memflow_root.display()
    );

    Ok(child)
}

/// Kill a child process and its process group.
fn kill_process(child: &mut Child) {
    let pid = child.id();
    log::info!("Stopping sidecar (PID: {})", pid);

    // Windows: use taskkill /T to kill the entire process tree
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }

    // Unix: kill the process group
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        // Wait briefly for graceful shutdown
        std::thread::sleep(Duration::from_secs(2));
        // Force kill if still running
        let _ = child.kill();
    }

    // On Windows, taskkill already handled it, but call wait to reap
    let _ = child.wait();
    log::info!("Sidecar stopped (PID: {})", pid);
}

// ─────────────────────────── Tauri Commands ───────────────────────────

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
    let has_child = state.child.lock().unwrap().is_some();

    serde_json::json!({
        "healthy": is_healthy,
        "port": port,
        "mode": format!("{:?}", mode),
        "restartCount": restart_count,
        "serverUrl": *state.server_url.lock().unwrap(),
        "processRunning": has_child,
    })
}

/// Tauri command: Set connection to external server
#[tauri::command]
pub fn set_external_server(url: String, state: tauri::State<SidecarState>) -> bool {
    // Stop any running sidecar first
    if let Some(ref mut child) = *state.child.lock().unwrap() {
        kill_process(child);
    }
    *state.child.lock().unwrap() = None;

    *state.mode.lock().unwrap() = ConnectionMode::ExternalServer(url.clone());
    *state.server_url.lock().unwrap() = url;
    true
}

/// Tauri command: Check if a URL is reachable (health endpoint)
#[tauri::command]
pub async fn check_health(url: String) -> Result<HealthResponse, String> {
    check_health_internal(&url).await
}

/// Tauri command: Start the sidecar process
#[tauri::command]
pub async fn start_sidecar(
    state: tauri::State<'_, SidecarState>,
) -> Result<serde_json::Value, String> {
    // Check if already running
    {
        let child_guard = state.child.lock().unwrap();
        if child_guard.is_some() {
            return Ok(serde_json::json!({
                "status": "already_running",
                "serverUrl": *state.server_url.lock().unwrap(),
            }));
        }
    }

    // Detect memflow root
    let root = {
        let mut root_guard = state.memflow_root.lock().unwrap();
        if root_guard.is_none() {
            *root_guard = detect_memflow_root();
        }
        root_guard.clone()
    };

    let memflow_root = root.ok_or_else(|| {
        "Cannot find memflow repo root. Set MEMFLOW_ROOT environment variable.".to_string()
    })?;

    // Find available port
    let port = find_available_port()
        .ok_or_else(|| "No available port in range 3000-3099".to_string())?;

    // Update state
    *state.port.lock().unwrap() = port;
    let server_url = format!("http://127.0.0.1:{}", port);
    *state.server_url.lock().unwrap() = server_url.clone();
    *state.mode.lock().unwrap() = ConnectionMode::EmbeddedSidecar;
    *state.restart_count.lock().unwrap() = 0;

    // Spawn process
    let child = spawn_bun_process(&memflow_root, port)?;
    *state.child.lock().unwrap() = Some(child);

    // Wait for health check (poll for up to 30s)
    let mut healthy = false;
    for i in 0..60 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        match check_health_internal(&server_url).await {
            Ok(resp) if resp.status == "ok" || resp.status == "degraded" => {
                log::info!("Sidecar healthy after {}ms", (i + 1) * 500);
                *state.is_healthy.lock().unwrap() = true;
                healthy = true;
                break;
            }
            _ => {}
        }
    }

    if !healthy {
        log::warn!("Sidecar started but health check not passing after 30s");
    }

    Ok(serde_json::json!({
        "status": if healthy { "healthy" } else { "started_unhealthy" },
        "serverUrl": server_url,
        "port": port,
    }))
}

/// Tauri command: Stop the sidecar process
#[tauri::command]
pub fn stop_sidecar(state: tauri::State<SidecarState>) -> bool {
    let mut child_guard = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        kill_process(child);
        *child_guard = None;
        *state.is_healthy.lock().unwrap() = false;
        *state.restart_count.lock().unwrap() = 0;
        log::info!("Sidecar stopped by user command");
        true
    } else {
        log::info!("No sidecar process to stop");
        false
    }
}

// ─────────────────────── Background Health Monitor ───────────────────────

/// Start a background health polling loop.
///
/// Polls GET /health every 5 seconds. If the sidecar process dies,
/// attempts restart with exponential backoff (1s, 2s, 4s, ..., max 30s).
pub fn start_health_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut consecutive_failures: u32 = 0;

        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;

            let state = app.state::<SidecarState>();

            // Only monitor in EmbeddedSidecar mode
            let mode = state.mode.lock().unwrap().clone();
            let is_embedded = matches!(mode, ConnectionMode::EmbeddedSidecar);

            let server_url = state.server_url.lock().unwrap().clone();

            match check_health_internal(&server_url).await {
                Ok(resp) if resp.status == "ok" || resp.status == "degraded" => {
                    *state.is_healthy.lock().unwrap() = true;
                    consecutive_failures = 0;
                }
                _ => {
                    *state.is_healthy.lock().unwrap() = false;
                    consecutive_failures += 1;

                    // Only auto-restart if we're in embedded mode
                    if is_embedded && consecutive_failures >= 3 {
                        let restart_count = *state.restart_count.lock().unwrap();

                        if restart_count < state.max_restarts {
                            log::warn!(
                                "Sidecar unhealthy ({} consecutive failures), attempting restart #{}/{}",
                                consecutive_failures,
                                restart_count + 1,
                                state.max_restarts
                            );

                            // Kill existing process if any
                            {
                                let mut child_guard = state.child.lock().unwrap();
                                if let Some(ref mut child) = *child_guard {
                                    kill_process(child);
                                }
                                *child_guard = None;
                            }

                            // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s
                            let backoff_secs = std::cmp::min(
                                1u64 << restart_count,
                                30,
                            );
                            log::info!("Waiting {}s before restart...", backoff_secs);
                            tokio::time::sleep(Duration::from_secs(backoff_secs)).await;

                            // Try to restart
                            let root = state.memflow_root.lock().unwrap().clone();
                            let port = *state.port.lock().unwrap();

                            if let Some(memflow_root) = root {
                                match spawn_bun_process(&memflow_root, port) {
                                    Ok(child) => {
                                        *state.child.lock().unwrap() = Some(child);
                                        *state.restart_count.lock().unwrap() += 1;
                                        consecutive_failures = 0;
                                        log::info!("Sidecar restarted successfully");
                                    }
                                    Err(e) => {
                                        log::error!("Failed to restart sidecar: {}", e);
                                        *state.restart_count.lock().unwrap() += 1;
                                    }
                                }
                            }
                        } else if restart_count >= state.max_restarts {
                            log::error!(
                                "Sidecar exceeded max restarts ({}). Manual intervention required.",
                                state.max_restarts
                            );
                            // Stop trying — user needs to manually restart via UI
                        }
                    }
                }
            }
        }
    });
}

/// Clean up sidecar process on app exit.
pub fn cleanup_sidecar(app: &AppHandle) {
    let state = app.state::<SidecarState>();
    let mut child_guard = state.child.lock().unwrap();
    if let Some(ref mut child) = *child_guard {
        log::info!("App exiting — cleaning up sidecar process");
        kill_process(child);
        *child_guard = None;
    }
}
