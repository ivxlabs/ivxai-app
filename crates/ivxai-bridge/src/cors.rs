// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! Which browser origins may use this bridge, and the headers that tell them so.
//!
//! The bridge is an open forwarder for whoever can talk to it, so the origin
//! allowlist is the whole security boundary. It holds because a browser sets
//! `Origin` itself and a page cannot forge it — so a random site the user
//! visits cannot borrow the bridge to reach their private network.
//!
//! A request with *no* `Origin` is allowed. Those come from non-browser
//! clients and from same-origin calls made by a UI the bridge is serving
//! itself, and anything that can open a socket to loopback could already reach
//! the same endpoints directly. The token (`Config::token`) is there for the
//! case where that is not true — a shared or multi-user machine.

use hyper::header::{HeaderMap, HeaderName, HeaderValue};
use hyper::http::header;

/// One entry in the allowlist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginRule {
    /// An exact origin, e.g. `https://o.eval.blog`.
    Exact(String),
    /// Any loopback origin on any port — how the app is served in development.
    Loopback,
}

#[derive(Debug, Clone)]
pub enum OriginPolicy {
    /// Every origin. Convenient while developing, careless anywhere else.
    Any,
    List(Vec<OriginRule>),
}

/// Where ivx/ai Chat is normally served from, plus the origins a webview uses.
pub fn default_rules() -> Vec<OriginRule> {
    [
        "https://ai.ivx.run",
        // Where the app was hosted before ivx.run, and a Pages deploy of the
        // repository. Both are ours; anything else needs --allow-origin.
        "https://o.eval.blog",
        "https://ivxlabs.github.io",
        // Tauri v2 webviews: custom scheme on Apple platforms, http elsewhere.
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
    ]
    .iter()
    .map(|o| OriginRule::Exact((*o).to_string()))
    .chain(std::iter::once(OriginRule::Loopback))
    .collect()
}

/// `http://localhost:5173`, `http://127.0.0.1:4173`, `http://[::1]` and friends.
fn is_loopback_origin(origin: &str) -> bool {
    let Some(rest) = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
    else {
        return false;
    };
    // An origin is scheme + host + port and nothing else.
    if rest.contains('/') {
        return false;
    }
    // Split a trailing `:port`, taking care not to cut an IPv6 literal in half.
    let host = match rest.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => rest,
    };
    matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

impl OriginPolicy {
    /// `None` means the request carried no `Origin` — see the module note.
    pub fn allows(&self, origin: Option<&str>) -> bool {
        let Some(origin) = origin else { return true };
        match self {
            OriginPolicy::Any => true,
            OriginPolicy::List(rules) => rules.iter().any(|rule| match rule {
                OriginRule::Exact(want) => want.eq_ignore_ascii_case(origin),
                OriginRule::Loopback => is_loopback_origin(origin),
            }),
        }
    }

    pub fn describe(&self) -> String {
        match self {
            OriginPolicy::Any => "any origin (--allow-any-origin)".to_string(),
            OriginPolicy::List(rules) => {
                let mut parts: Vec<String> = rules
                    .iter()
                    .map(|r| match r {
                        OriginRule::Exact(o) => o.clone(),
                        OriginRule::Loopback => "http://localhost:*".to_string(),
                    })
                    .collect();
                parts.sort();
                parts.join(", ")
            }
        }
    }
}

const EXPOSED: &str = "*";
const DEFAULT_REQUEST_HEADERS: &str = "authorization, content-type, x-api-key, anthropic-version, \
     anthropic-dangerous-direct-browser-access, x-ivx-token";

/// Add the headers that let `origin` read this response.
///
/// `Access-Control-Allow-Credentials` is deliberately never sent: the bridge
/// has no session of its own, and omitting it is what keeps the wildcard in
/// `Access-Control-Expose-Headers` legal.
pub fn allow(headers: &mut HeaderMap, origin: Option<&str>) {
    // `Vary` goes on every response, including the ones we refuse, so a shared
    // cache never serves one origin's answer to another.
    headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    let Some(origin) = origin else { return };
    let Ok(value) = HeaderValue::from_str(origin) else {
        return;
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static(EXPOSED),
    );
}

/// Fill in the preflight answer for a request that we are willing to serve.
pub fn preflight(out: &mut HeaderMap, req: &HeaderMap, origin: Option<&str>) {
    allow(out, origin);
    out.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS"),
    );
    // Echoing what was asked for beats maintaining a list that silently rots
    // as providers invent new headers.
    let asked = req
        .get(header::ACCESS_CONTROL_REQUEST_HEADERS)
        .cloned()
        .unwrap_or_else(|| HeaderValue::from_static(DEFAULT_REQUEST_HEADERS));
    out.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, asked);
    out.insert(
        header::ACCESS_CONTROL_MAX_AGE,
        HeaderValue::from_static("600"),
    );

    // Chrome's Private Network Access check: a page on a public origin may only
    // reach loopback if the preflight opts in. Without this the whole bridge is
    // unreachable from the hosted build, with a CORS error that names nothing.
    if req.contains_key("access-control-request-private-network") {
        out.insert(
            HeaderName::from_static("access-control-allow-private-network"),
            HeaderValue::from_static("true"),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_origins_match_on_any_port() {
        assert!(is_loopback_origin("http://localhost:5173"));
        assert!(is_loopback_origin("http://127.0.0.1:4173"));
        assert!(is_loopback_origin("http://localhost"));
        assert!(is_loopback_origin("http://[::1]"));
        assert!(is_loopback_origin("http://[::1]:8787"));
        assert!(is_loopback_origin("https://localhost:8443"));
    }

    #[test]
    fn lookalike_hosts_do_not_match() {
        assert!(!is_loopback_origin("http://localhost.evil.com"));
        assert!(!is_loopback_origin("http://127.0.0.1.evil.com"));
        assert!(!is_loopback_origin("http://evil.com/localhost"));
        assert!(!is_loopback_origin("http://notlocalhost"));
        assert!(!is_loopback_origin("file://"));
    }

    #[test]
    fn default_policy_allows_the_hosted_app_and_rejects_strangers() {
        let policy = OriginPolicy::List(default_rules());
        assert!(policy.allows(Some("https://ai.ivx.run")));
        assert!(policy.allows(Some("https://o.eval.blog")));
        assert!(policy.allows(Some("https://ivxlabs.github.io")));
        assert!(policy.allows(Some("tauri://localhost")));
        assert!(policy.allows(Some("http://localhost:5173")));
        assert!(!policy.allows(Some("https://evil.example")));
        assert!(!policy.allows(Some("https://ai.ivx.run.evil.example")));
        assert!(!policy.allows(Some("https://o.eval.blog.evil.example")));
    }

    #[test]
    fn a_missing_origin_is_not_a_browser_and_is_allowed() {
        assert!(OriginPolicy::List(default_rules()).allows(None));
    }
}
