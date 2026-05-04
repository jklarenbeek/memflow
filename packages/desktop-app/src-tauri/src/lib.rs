mod sidecar;

use sidecar::SidecarState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Focus the existing window when a second instance is launched
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            sidecar::get_server_url,
            sidecar::get_sidecar_status,
            sidecar::set_external_server,
            sidecar::check_health,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
