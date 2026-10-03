// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! Forwarding one request upstream and streaming the answer back.
//!
//! Nothing here inspects or rewrites a body. Chat completions arrive as SSE or
//! newline-delimited JSON and have to reach the browser as they are produced,
//! so the response is piped through frame by frame — buffering it would turn a
//! streaming UI into a progress-free wait.

use bytes::Bytes;
use futures_util::TryStreamExt;
use http_body_util::{BodyExt, Limited, StreamBody};
use hyper::body::{Frame, Incoming};
use hyper::header::{HeaderMap, HeaderName};
use hyper::{Method, Request, Response, StatusCode, Uri};

use crate::{json_error, Body, State};

/// A prompt is text. 32 MiB is far past any real one and still refuses a
/// client that means to exhaust memory.
const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

/// Headers that describe *this* hop and must not be repeated to the next one,
/// plus the ones the browser attaches that upstream has no business seeing.
/// `origin` and `referer` matter most: several providers reject a request that
/// arrives claiming to come from a web page they do not know.
const STRIP_REQUEST: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "content-length",
    "origin",
    "referer",
    "cookie",
    // Asking for identity keeps the streamed bytes exactly as the provider
    // framed them, which is what the SSE parser in the browser expects.
    "accept-encoding",
    "sec-fetch-mode",
    "sec-fetch-site",
    "sec-fetch-dest",
    "sec-fetch-user",
    "x-ivx-token",
];

/// Framing belongs to the connection we are about to write, not the one we
/// read, and our CORS headers replace whatever the provider sent.
fn strip_response(name: &HeaderName) -> bool {
    let n = name.as_str();
    n == "connection"
        || n == "keep-alive"
        || n == "transfer-encoding"
        || n == "content-length"
        || n == "trailer"
        || n == "upgrade"
        || n.starts_with("access-control-")
}

/// Pull the `url` query parameter out of `/proxy?url=…`.
fn target_of(uri: &Uri) -> Result<reqwest::Url, String> {
    let query = uri.query().unwrap_or("");
    // Parsing against a throwaway base is the cheapest correct way to get
    // percent-decoded query pairs without another dependency.
    let holder = reqwest::Url::parse(&format!("http://bridge.invalid/?{query}"))
        .map_err(|_| "Malformed query string".to_string())?;
    let raw = holder
        .query_pairs()
        .find(|(k, _)| k == "url")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| "Missing the `url` parameter: /proxy?url=<absolute URL>".to_string())?;

    let target = reqwest::Url::parse(&raw).map_err(|e| format!("`url` is not a URL: {e}"))?;
    match target.scheme() {
        "http" | "https" => {}
        other => return Err(format!("Refusing to forward to a `{other}:` URL")),
    }
    if !target.has_host() {
        return Err("`url` has no host".to_string());
    }
    Ok(target)
}

/// Compare in time that does not depend on how many bytes matched.
fn token_matches(expected: &str, given: Option<&str>) -> bool {
    let given = given.unwrap_or("");
    if expected.len() != given.len() {
        return false;
    }
    expected
        .bytes()
        .zip(given.bytes())
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn presented_token(req: &Request<Incoming>) -> Option<String> {
    if let Some(v) = req
        .headers()
        .get("x-ivx-token")
        .and_then(|v| v.to_str().ok())
    {
        return Some(v.to_string());
    }
    let holder =
        reqwest::Url::parse(&format!("http://bridge.invalid/?{}", req.uri().query()?)).ok()?;
    holder
        .query_pairs()
        .find(|(k, _)| k == "token")
        .map(|(_, v)| v.into_owned())
}

pub async fn handle(state: &State, req: Request<Incoming>, origin: Option<&str>) -> Response<Body> {
    if let Some(expected) = state.config.token.as_deref() {
        if !token_matches(expected, presented_token(&req).as_deref()) {
            return json_error(
                state,
                StatusCode::UNAUTHORIZED,
                "This bridge was started with --token; pass it as ?token= or X-Ivx-Token.",
                origin,
            );
        }
    }

    let target = match target_of(req.uri()) {
        Ok(t) => t,
        Err(message) => return json_error(state, StatusCode::BAD_REQUEST, &message, origin),
    };

    let (parts, body) = req.into_parts();

    // The request body is buffered rather than streamed. Prompts are small, and
    // a known Content-Length avoids the chunked upload that a few OpenAI-
    // compatible servers still reject. Only the response has to stream.
    let has_body = !matches!(parts.method, Method::GET | Method::HEAD);
    let bytes = if has_body {
        match Limited::new(body, MAX_REQUEST_BODY).collect().await {
            Ok(c) => c.to_bytes(),
            Err(_) => {
                return json_error(
                    state,
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Request body is too large to forward.",
                    origin,
                )
            }
        }
    } else {
        Bytes::new()
    };

    let mut upstream = state.client.request(parts.method.clone(), target.clone());
    let mut forwarded = HeaderMap::new();
    for (name, value) in parts.headers.iter() {
        if STRIP_REQUEST.contains(&name.as_str()) {
            continue;
        }
        forwarded.append(name.clone(), value.clone());
    }
    upstream = upstream.headers(forwarded);
    if has_body {
        upstream = upstream.body(bytes);
    }

    let res = match upstream.send().await {
        Ok(res) => res,
        Err(err) => {
            let host = target.host_str().unwrap_or("the endpoint");
            return json_error(
                state,
                StatusCode::BAD_GATEWAY,
                &format!("Could not reach {host}: {}", root_cause(&err)),
                origin,
            );
        }
    };

    state.log(&format!(
        "{} {} -> {}",
        parts.method,
        target.host_str().unwrap_or("?"),
        res.status().as_u16()
    ));

    let mut out = Response::builder().status(res.status());
    {
        let headers = out.headers_mut().expect("builder has no error yet");
        for (name, value) in res.headers().iter() {
            if strip_response(name) {
                continue;
            }
            headers.append(name.clone(), value.clone());
        }
        crate::cors::allow(headers, origin);
    }

    let stream = res
        .bytes_stream()
        .map_ok(Frame::data)
        .map_err(|e| Box::new(e) as crate::BoxError);
    out.body(StreamBody::new(stream).boxed())
        .unwrap_or_else(|_| {
            json_error(
                state,
                StatusCode::BAD_GATEWAY,
                "Malformed upstream response",
                origin,
            )
        })
}

/// reqwest wraps its errors several layers deep; the innermost one is the only
/// part a person can act on ("connection refused", "dns error", …).
fn root_cause(err: &reqwest::Error) -> String {
    let mut source: &dyn std::error::Error = err;
    while let Some(next) = source.source() {
        source = next;
    }
    source.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uri(s: &str) -> Uri {
        s.parse().unwrap()
    }

    #[test]
    fn extracts_and_decodes_the_target() {
        let got = target_of(&uri(
            "/proxy?url=https%3A%2F%2Fapi.openai.com%2Fv1%2Fchat%2Fcompletions",
        ))
        .unwrap();
        assert_eq!(got.as_str(), "https://api.openai.com/v1/chat/completions");
    }

    #[test]
    fn keeps_the_targets_own_query_string() {
        let got = target_of(&uri(
            "/proxy?url=https%3A%2F%2Fapi.anthropic.com%2Fv1%2Fmodels%3Flimit%3D1000",
        ))
        .unwrap();
        assert_eq!(got.query(), Some("limit=1000"));
    }

    #[test]
    fn rejects_targets_that_are_not_http() {
        assert!(target_of(&uri("/proxy?url=file%3A%2F%2F%2Fetc%2Fpasswd")).is_err());
        assert!(target_of(&uri("/proxy?url=not-a-url")).is_err());
        assert!(target_of(&uri("/proxy")).is_err());
    }

    #[test]
    fn token_comparison_rejects_wrong_and_short_values() {
        assert!(token_matches("s3cret", Some("s3cret")));
        assert!(!token_matches("s3cret", Some("s3cres")));
        assert!(!token_matches("s3cret", Some("s3c")));
        assert!(!token_matches("s3cret", None));
    }
}
