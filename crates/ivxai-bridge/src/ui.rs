// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! Optionally serving a built copy of ivx/ai Chat (`--ui-dir dist`).
//!
//! Not the point of the bridge, but it removes a class of problem rather than
//! documenting around it: served from here, the page and the bridge are the
//! same origin, so nothing is cross-origin and nothing is mixed content. That
//! is the only way the hosted app works in Safari, which still refuses
//! `http://127.0.0.1` from an HTTPS page.

use std::path::{Component, Path, PathBuf};

use hyper::{header, Response, StatusCode};

use crate::{full, json_error, Body, State};

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// Resolve a request path inside `root`, refusing anything that climbs out.
///
/// The check is on the parsed components rather than on the string, so the
/// usual `%2e%2e` and `....//` dodges are already decoded into `ParentDir` by
/// the time we look.
fn resolve(root: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = request_path.trim_start_matches('/');
    let decoded = percent_decode(relative);
    let candidate = Path::new(&decoded);
    for part in candidate.components() {
        match part {
            Component::Normal(_) => {}
            // Everything else means the path was trying to leave.
            _ => return None,
        }
    }
    Some(root.join(candidate))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub async fn serve(
    state: &State,
    root: &Path,
    request_path: &str,
    origin: Option<&str>,
) -> Response<Body> {
    let index = root.join("index.html");
    let file = match resolve(root, request_path) {
        Some(p) if p.is_dir() => p.join("index.html"),
        Some(p) => p,
        None => {
            return json_error(state, StatusCode::BAD_REQUEST, "Bad path", origin);
        }
    };

    // One document, so anything unrecognised is the document. Keeps deep links
    // working without the bridge needing to know the app's routes.
    let (path, body) = match tokio::fs::read(&file).await {
        Ok(bytes) => (file, bytes),
        Err(_) => match tokio::fs::read(&index).await {
            Ok(bytes) => (index, bytes),
            Err(_) => {
                return json_error(
                    state,
                    StatusCode::NOT_FOUND,
                    "Not found. Is --ui-dir pointing at a built copy of the app?",
                    origin,
                )
            }
        },
    };

    let mut res = Response::new(full(body));
    let headers = res.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(content_type(&path)),
    );
    // Vite fingerprints its assets, so they are immutable; the entry document
    // and the service worker are not and must be revalidated.
    let immutable = path.starts_with(root.join("assets"));
    headers.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }),
    );
    crate::cors::allow(headers, origin);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_paths_resolve_under_the_root() {
        let root = Path::new("/srv/ui");
        assert_eq!(
            resolve(root, "/assets/app.js"),
            Some(PathBuf::from("/srv/ui/assets/app.js"))
        );
    }

    #[test]
    fn traversal_is_refused_however_it_is_spelled() {
        let root = Path::new("/srv/ui");
        assert_eq!(resolve(root, "/../../etc/passwd"), None);
        assert_eq!(resolve(root, "/%2e%2e/%2e%2e/etc/passwd"), None);
        assert_eq!(resolve(root, "/assets/../../../etc/passwd"), None);
        // Leading slashes collapse rather than escaping, so this stays inside.
        assert_eq!(
            resolve(root, "//etc/passwd"),
            Some(PathBuf::from("/srv/ui/etc/passwd"))
        );
    }

    #[test]
    fn percent_decoding_handles_truncated_escapes() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("a%"), "a%");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("a%zz"), "a%zz");
    }
}
