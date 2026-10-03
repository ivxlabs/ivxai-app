// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! ivx/ai Chat as an installed app.
//!
//! The webview is the same ivx/ai Chat that runs on the web — the build in
//! `web/`, and this crate adds nothing to the page. What it adds is a
//! [`ivxai_bridge`] server running in-process on an ephemeral loopback port,
//! which is how the app escapes CORS: providers that refuse a browser origin
//! are reached through the bridge instead.
//!
//! The alternative would have been to route provider calls through Tauri's IPC
//! and a Rust-side HTTP client. That means a second networking path that only
//! exists in the app, with its own streaming behaviour to get right and its own
//! bugs — and the UI would have to know which one it was running on. Reusing
//! the bridge means the web build, the desktop app and the mobile app all make
//! the same `fetch` to the same kind of endpoint.

use std::sync::Arc;

use ivxai_bridge::{Config, State};

/// Handed to the page so it can find the bridge without probing for it.
///
/// Injected as a webview initialization script, which runs in the webview's
/// own privileged context and so is not subject to the page's
/// `script-src 'self'` — the app keeps its Content-Security-Policy intact.
fn init_script(port: u16, token: &str) -> String {
    // Both values are ours: a u16 and hex from the system RNG. Nothing here
    // comes from the page or the network.
    format!(
        r#"Object.defineProperty(window, "__IVXAI_BRIDGE__", {{
  value: Object.freeze({{ url: "http://127.0.0.1:{port}", token: "{token}", source: "app" }}),
  writable: false, configurable: false
}});"#
    )
}

/// Keep the opening window inside the screen it actually opens on.
///
/// tauri.conf.json asks for a desktop-shaped 1100x820, which is right on a
/// large display and taller than the usable area of a 1366x768 laptop. Rather
/// than pick a size small enough to be safe everywhere and cramped everywhere,
/// take the smaller of the two — and leave a margin, because the reported
/// screen includes the menu bar, dock or taskbar sitting on top of it.
#[cfg(desktop)]
fn fit_to_screen(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use tauri::LogicalSize;

    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let screen = monitor.size().to_logical::<f64>(monitor.scale_factor());
    let asked = window
        .outer_size()?
        .to_logical::<f64>(window.scale_factor()?);

    let width = asked.width.min(screen.width * 0.9);
    let height = asked.height.min(screen.height * 0.85);
    if width < asked.width || height < asked.height {
        window.set_size(LogicalSize::new(width, height))?;
        window.center()?;
    }
    Ok(())
}

/// Carries the script to every webview, including the ones declared in
/// `tauri.conf.json` — a plugin is the only hook that reaches those.
fn bridge_plugin<R: tauri::Runtime>(script: String) -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R, ()>::new("ivxai-bridge")
        .js_init_script(script)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Bound here, before the builder, because the page needs the port and the
    // initialization script has to be in place before the first document loads.
    // Port 0 lets the OS pick, so two copies of the app never collide.
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .expect("could not open a loopback port for the bridge");
    let port = listener
        .local_addr()
        .expect("a bound listener has an address")
        .port();
    let token = ivxai_bridge::random_token();

    let bridge_token = token.clone();
    tauri::Builder::default()
        .plugin(bridge_plugin(init_script(port, &token)))
        .setup(move |app| {
            #[cfg(desktop)]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    // Not fatal: a window that opens too big is survivable, a
                    // panic on a monitor query is not.
                    let _ = fit_to_screen(&window);
                }
            }

            let config = Config {
                // The port is ephemeral but still reachable by anything on this
                // machine, so the token is what ties it to this webview.
                token: Some(bridge_token),
                // IVX_VERBOSE=1 turns the request log on in a shipped build.
                // Without it there is no way to see what the webview is asking
                // for, and a release app is exactly where that goes wrong.
                verbose: cfg!(debug_assertions) || std::env::var_os("IVX_VERBOSE").is_some(),
                ..Config::default()
            };
            let state = Arc::new(
                State::new(config).map_err(|err| format!("could not start the bridge: {err}"))?,
            );

            listener.set_nonblocking(true)?;
            tauri::async_runtime::spawn(async move {
                // Adopting the socket has to happen in here: `from_std` registers
                // it with the running reactor, and `setup` is called on the main
                // thread before any runtime is entered.
                let listener = match tokio::net::TcpListener::from_std(listener) {
                    Ok(listener) => listener,
                    Err(err) => return eprintln!("ivx: bridge could not start: {err}"),
                };
                if let Err(err) = ivxai_bridge::serve(listener, state).await {
                    // Losing the bridge is not fatal: providers that send their
                    // own CORS headers keep working, and the UI reports the
                    // bridge as unavailable rather than pretending otherwise.
                    eprintln!("ivx: bridge stopped: {err}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ivx/ai Chat");
}
