// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! The ivx/ai Chat bridge: a loopback HTTP server that answers preflights so
//! a browser will let the app talk to endpoints that do not send CORS headers
//! of their own — Ollama on its default settings, a bare llama.cpp build, an
//! internal proxy someone set up years ago.
//!
//! It is deliberately one small thing. It does not know what a chat completion
//! is, it never parses a body, and it keeps nothing: a request arrives with the
//! target in `?url=`, it goes out again with the browser-specific headers
//! removed, and the response streams straight back. API keys pass through in
//! the headers the browser set and are never logged or written to disk.
//!
//! The same server is what the Tauri app runs in-process, on an ephemeral port
//! behind a random token, so desktop, mobile and "just the daemon" all take the
//! identical path through the UI.
//!
//! ```no_run
//! # async fn run() -> Result<(), ivxai_bridge::BoxError> {
//! use std::sync::Arc;
//! let listener = tokio::net::TcpListener::bind("127.0.0.1:8787").await?;
//! let state = Arc::new(ivxai_bridge::State::new(ivxai_bridge::Config::default())?);
//! ivxai_bridge::serve(listener, state).await?;
//! # Ok(()) }
//! ```

pub mod cors;
mod mcp;
mod proxy;
mod ui;

use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{combinators::BoxBody, BodyExt, Empty, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{header, HeaderMap, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::net::TcpListener;

use mcp::McpSessions;

pub use cors::{OriginPolicy, OriginRule};
pub type BoxError = Box<dyn std::error::Error + Send + Sync>;
pub type Body = BoxBody<Bytes, BoxError>;

/// Bumped when `/proxy` changes shape. `/health` reports it so the UI can say
/// "update the bridge" instead of failing in some unreadable way.
pub const PROTOCOL: u32 = 1;
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The port the standalone daemon uses unless told otherwise. Picked because
/// nothing common listens there; the UI probes it when you ask it to look.
pub const DEFAULT_PORT: u16 = 8787;

pub struct Config {
    pub origins: OriginPolicy,
    /// When set, `/proxy` requires it as `?token=` or `X-Ivx-Token`.
    pub token: Option<String>,
    /// Serve a built copy of ivx/ai Chat from this directory.
    ///
    /// Worth doing on Safari, which — unlike Chrome and Firefox — still counts
    /// `http://127.0.0.1` as mixed content when the page itself came over
    /// HTTPS. Served from here the page and the bridge share an origin, so
    /// there is no mixed content and no cross-origin request left to block.
    pub ui_dir: Option<PathBuf>,
    pub connect_timeout: Duration,
    /// Skip TLS verification upstream. For a local server with a self-signed
    /// certificate, and nothing else.
    pub insecure: bool,
    pub verbose: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            origins: OriginPolicy::List(cors::default_rules()),
            token: None,
            ui_dir: None,
            connect_timeout: Duration::from_secs(30),
            insecure: false,
            verbose: false,
        }
    }
}

pub struct State {
    pub config: Config,
    /// Live stdio MCP processes, keyed by session id. Owns the one route that
    /// can start programs on this machine; see `mcp`.
    pub mcp: McpSessions,
    client: reqwest::Client,
}

impl State {
    pub fn new(config: Config) -> Result<Self, BoxError> {
        let client = reqwest::Client::builder()
            .connect_timeout(config.connect_timeout)
            // No overall timeout on purpose: a streamed completion is a single
            // response that can legitimately stay open for many minutes.
            .danger_accept_invalid_certs(config.insecure)
            .user_agent(format!("ivxai-bridge/{VERSION}"))
            .build()?;
        Ok(Self {
            config,
            mcp: McpSessions::default(),
            client,
        })
    }

    fn log(&self, line: &str) {
        if self.config.verbose {
            eprintln!("  {line}");
        }
    }
}

/// 24 bytes of system randomness, hex encoded. Used by the Tauri app to lock
/// its in-process bridge to its own webview.
pub fn random_token() -> String {
    let mut raw = [0u8; 24];
    getrandom::fill(&mut raw).expect("the system random source is unavailable");
    raw.iter().fold(String::with_capacity(48), |mut s, b| {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Accept connections until the listener fails.
pub async fn serve(listener: TcpListener, state: Arc<State>) -> Result<(), BoxError> {
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(pair) => pair,
            // One refused connection should not take the daemon down with it.
            Err(err) if err.kind() == std::io::ErrorKind::ConnectionAborted => continue,
            Err(err) => return Err(err.into()),
        };
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let service = service_fn(move |req| route(Arc::clone(&state), req));
            if let Err(err) = http1::Builder::new()
                .keep_alive(true)
                .serve_connection(TokioIo::new(stream), service)
                .await
            {
                // Closing the tab mid-stream lands here. It is not an error.
                let _ = err;
            }
        });
    }
}

async fn route(state: Arc<State>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
    let origin = req
        .headers()
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let origin = origin.as_deref();
    let path = req.uri().path().to_owned();
    let is_health = path == "/health" || path == "/__ivx/health";

    if req.method() == Method::OPTIONS {
        // `/health` answers everyone: a page that cannot read it cannot tell
        // "no bridge here" apart from "bridge here, but not for you".
        let permitted = is_health || state.config.origins.allows(origin);
        let mut res = Response::new(empty());
        *res.status_mut() = if permitted {
            StatusCode::NO_CONTENT
        } else {
            StatusCode::FORBIDDEN
        };
        if permitted {
            cors::preflight(res.headers_mut(), req.headers(), origin);
        } else {
            cors::allow(res.headers_mut(), None);
        }
        return Ok(res);
    }

    if is_health {
        return Ok(health(&state, origin));
    }

    if !state.config.origins.allows(origin) {
        state.log(&format!("refused origin {}", origin.unwrap_or("-")));
        return Ok(json_error(
            &state,
            StatusCode::FORBIDDEN,
            &format!(
                "This bridge does not accept requests from {}. Restart it with \
                 --allow-origin {} to let it through.",
                origin.unwrap_or("that origin"),
                origin.unwrap_or("<origin>")
            ),
            origin,
        ));
    }

    if path == "/proxy" {
        return Ok(proxy::handle(&state, req, origin).await);
    }

    if path == "/mcp/stdio" {
        return Ok(mcp::handle(&state, req, origin).await);
    }

    Ok(match state.config.ui_dir.as_deref() {
        Some(dir) => ui::serve(&state, dir, &path, origin).await,
        None => json_error(
            &state,
            StatusCode::NOT_FOUND,
            "Not a bridge route. Try /health, or /proxy?url=<absolute URL>.",
            origin,
        ),
    })
}

/// What the UI probes to find out whether a bridge is here and willing.
fn health(state: &State, origin: Option<&str>) -> Response<Body> {
    state.log(&format!("health from {}", origin.unwrap_or("-")));
    let body = format!(
        concat!(
            r#"{{"ok":true,"name":"ivxai-bridge","version":"{}","protocol":{},"#,
            r#""originAllowed":{},"needsToken":{},"servesUi":{},"mcp":{}}}"#
        ),
        VERSION,
        PROTOCOL,
        state.config.origins.allows(origin),
        state.config.token.is_some(),
        state.config.ui_dir.is_some(),
        true,
    );
    let mut res = Response::new(full(body));
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    no_store(res.headers_mut());
    // Echoed unconditionally, including for origins `/proxy` would refuse —
    // that is the whole point of the `originAllowed` field.
    cors::allow(res.headers_mut(), origin);
    res
}

pub(crate) fn json_error(
    state: &State,
    status: StatusCode,
    message: &str,
    origin: Option<&str>,
) -> Response<Body> {
    state.log(&format!("{} {}", status.as_u16(), message));
    let body = format!(
        r#"{{"ok":false,"error":{{"message":"{}"}}}}"#,
        escape(message)
    );
    let mut res = Response::new(full(body));
    *res.status_mut() = status;
    res.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static("application/json"),
    );
    no_store(res.headers_mut());
    cors::allow(res.headers_mut(), origin);
    res
}

fn no_store(headers: &mut HeaderMap) {
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
}

/// Enough JSON string escaping for messages we generate ourselves.
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

pub(crate) fn full(body: impl Into<Bytes>) -> Body {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

pub(crate) fn empty() -> Body {
    Empty::<Bytes>::new()
        .map_err(|never| match never {})
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_messages_survive_being_put_in_json() {
        assert_eq!(escape(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(escape("a\nb"), "a\\nb");
        assert_eq!(escape("back\\slash"), "back\\\\slash");
    }

    #[test]
    fn tokens_are_unique_and_hex() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
    }
}
