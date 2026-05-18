// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod steam;

fn main() {
    // Steamworks init is feature-gated. Without the `steam` feature
    // (the default), `steam::init()` is a no-op stub — the wrapper
    // still runs but no achievements/presence fire.
    let steam_handle = steam::init();
    if let Some(h) = &steam_handle {
        eprintln!("[hoverbike] Steamworks init OK (app_id={})", h.app_id());
    } else {
        eprintln!("[hoverbike] running without Steamworks (no feature, or no STEAM_APPID set)");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        // Steam callbacks need to be pumped from the main thread on a
        // regular interval (Steam's docs say "every frame"; once per
        // second is fine for achievements + presence). Tauri's runtime
        // lets us run a tick on the main loop via a managed state.
        .setup(move |_app| {
            #[cfg(feature = "steam")]
            if let Some(handle) = &steam_handle {
                steam::start_callback_pump(handle.clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            steam::cmd_record_achievement,
            steam::cmd_set_rich_presence,
        ])
        .run(tauri::generate_context!())
        .expect("error while running hoverbike");
}
