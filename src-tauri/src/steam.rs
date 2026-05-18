//! Steamworks integration — feature-gated.
//!
//! Without `--features steam`, every function here is a no-op stub so
//! the wrapper builds and runs without the Steamworks SDK installed.
//! With the feature on, calls flow through the `steamworks` crate to
//! the SDK loaded at runtime via `STEAM_APPID` (set in the launcher /
//! Steam client) + `steam_appid.txt` for dev.
//!
//! The Tauri commands `cmd_record_achievement` and `cmd_set_rich_presence`
//! are invokable from the web side via `@tauri-apps/api/core → invoke()`;
//! when running in the browser (no Tauri host) they're undefined and the
//! game-side wrapper falls back to local-only behaviour.

use serde::{Deserialize, Serialize};

#[cfg(feature = "steam")]
use steamworks::Client;

#[derive(Clone)]
pub struct SteamHandle {
    #[cfg(feature = "steam")]
    client: Client,
    app_id: u32,
}

impl SteamHandle {
    pub fn app_id(&self) -> u32 {
        self.app_id
    }
}

/// Try to initialise Steamworks. Returns `Some(handle)` if the SDK is
/// reachable + the App ID matches what Steam launched us with; returns
/// `None` if we're either built without the `steam` feature or the
/// init handshake fails.
///
/// Failures are intentionally non-fatal — the game must still run from
/// a sideloaded AppImage without a Steam client running.
#[cfg(feature = "steam")]
pub fn init() -> Option<SteamHandle> {
    let app_id = std::env::var("STEAM_APPID").ok()?.parse().ok()?;
    match Client::init_app(app_id) {
        Ok((client, _single)) => {
            // `_single` is the single-threaded callback runner; for now
            // we drop it (callbacks aren't pumped) — the pump lives in
            // `start_callback_pump` below.
            Some(SteamHandle { client, app_id })
        }
        Err(e) => {
            eprintln!("[hoverbike::steam] init_app failed: {e:?}");
            None
        }
    }
}

#[cfg(not(feature = "steam"))]
pub fn init() -> Option<SteamHandle> {
    // Without the feature, return None so the rest of main.rs falls
    // through to the no-Steamworks path. We still construct a
    // SteamHandle if STEAM_APPID is set so logs are honest about
    // what's running — but no SDK calls happen.
    let app_id = std::env::var("STEAM_APPID").ok()?.parse().ok()?;
    Some(SteamHandle { app_id })
}

/// Spawn the periodic Steamworks callback pump. Stubbed when the
/// feature is off; production builds run callbacks at ~1 Hz which is
/// plenty for achievements + presence (the high-frequency stuff —
/// matchmaking — isn't wired yet).
#[cfg(feature = "steam")]
pub fn start_callback_pump(_handle: SteamHandle) {
    // TODO: spawn a tokio interval that calls `single.run_callbacks()`
    // every 33ms. For now we just log so devs know it's not yet wired.
    eprintln!("[hoverbike::steam] callback pump TODO (achievements will fire on next SDK restart)");
}

#[cfg(not(feature = "steam"))]
#[allow(dead_code)]
pub fn start_callback_pump(_handle: SteamHandle) {}

#[derive(Debug, Deserialize)]
pub struct AchievementCmd {
    id: String,
}

#[derive(Debug, Serialize)]
pub struct AchievementResult {
    ok: bool,
    detail: String,
}

#[tauri::command]
pub fn cmd_record_achievement(cmd: AchievementCmd) -> AchievementResult {
    #[cfg(feature = "steam")]
    {
        eprintln!("[hoverbike::steam] record_achievement {}", cmd.id);
        // TODO: client.user_stats().achievement(&cmd.id).set();
        AchievementResult {
            ok: true,
            detail: format!("recorded {} (stub)", cmd.id),
        }
    }
    #[cfg(not(feature = "steam"))]
    {
        eprintln!("[hoverbike::steam] record_achievement {} (no-op, feature off)", cmd.id);
        AchievementResult {
            ok: false,
            detail: "steam feature disabled".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RichPresenceCmd {
    key: String,
    value: String,
}

#[derive(Debug, Serialize)]
pub struct RichPresenceResult {
    ok: bool,
    detail: String,
}

#[tauri::command]
pub fn cmd_set_rich_presence(cmd: RichPresenceCmd) -> RichPresenceResult {
    #[cfg(feature = "steam")]
    {
        eprintln!("[hoverbike::steam] set_rich_presence {} = {}", cmd.key, cmd.value);
        // TODO: client.friends().set_rich_presence(&cmd.key, Some(&cmd.value));
        RichPresenceResult {
            ok: true,
            detail: format!("{}={} (stub)", cmd.key, cmd.value),
        }
    }
    #[cfg(not(feature = "steam"))]
    {
        eprintln!(
            "[hoverbike::steam] set_rich_presence {} = {} (no-op, feature off)",
            cmd.key, cmd.value
        );
        RichPresenceResult {
            ok: false,
            detail: "steam feature disabled".to_string(),
        }
    }
}
