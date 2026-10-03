// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! Local MCP servers, reached from the browser through the bridge.
//!
//! A browser cannot spawn a process, so a stdio MCP server is unreachable from
//! the page even when it is running on the very same machine. The bridge is
//! already that machine's way of reaching things a browser cannot; this module
//! extends it to processes: it spawns the server, pipes one JSON-RPC message
//! per request into its stdin, and reads the matching response off stdout.
//!
//! One HTTP request carries one JSON-RPC message. The reply carries the
//! matching JSON-RPC response, or an empty `response` for a notification,
//! which needs no round-trip. A session is the process; it lives while it is
//! used and is reaped after `SESSION_IDLE` of nothing.
//!
//! This is the one bridge route that starts programs, and it should be named
//! as what it is: handing a page access to the bridge means handing it access
//! to your machine. It is gated behind the same origin rules and token as
//! `/proxy`, and exists so a page can use the tools on its own computer —
//! not so a stranger's page can use your shell.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use http_body_util::{BodyExt, Limited};
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{Mutex, OnceCell};

use crate::{json_error, Body, State};

/// One JSON-RPC message, not a bulk transfer. An MCP call is a few kilobytes;
/// this refuses a client that means to exhaust memory.
const MAX_BODY: usize = 8 * 1024 * 1024;

/// How long an unused session lives before its process is reaped. A tools
/// round-trip is seconds; ten minutes is many of them.
const SESSION_IDLE: Duration = Duration::from_secs(10 * 60);

/// How long to wait for one response. A tool call can legitimately be slow
/// (a web search, a long document fetch); two minutes covers those without
/// hanging the page on a server that stopped answering.
const SEND_TIMEOUT: Duration = Duration::from_secs(120);

/// A ceiling, so a misbehaving page cannot turn the bridge into a process farm.
const MAX_SESSIONS: usize = 32;

/// How long to wait on the login shell when asking it for a `PATH`. Startup
/// files can be slow — a version manager, a prompt framework — but past this
/// the answer is not worth the wait, and the fallbacks below will do.
const SHELL_TIMEOUT: Duration = Duration::from_secs(10);

/// Where to look when the shell has nothing to say: both Homebrew prefixes
/// and the base system. Empty off Unix, where `PATH` is inherited intact.
#[cfg(unix)]
const FALLBACK_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
#[cfg(not(unix))]
const FALLBACK_PATH: &str = "";

/// Asked once and kept: one shell startup for the life of the bridge.
static SEARCH_PATH: OnceCell<String> = OnceCell::const_new();

/// The `PATH` to look for MCP programs on.
///
/// The bridge is started as a service, not from a shell, so it does not have
/// a shell's `PATH`: launchd hands it `/usr/bin:/bin:/usr/sbin:/sbin`, and an
/// app launched from the desktop gets no better. None of that holds Homebrew,
/// nvm, or the other places a person's tools actually live — and an MCP server
/// is configured as exactly those tools (`npx`, `uvx`, `python`). Spawned off
/// the bridge's own `PATH` they come back "No such file or directory" for a
/// program the user can plainly run in their terminal.
///
/// So the login shell is asked what its `PATH` is, and MCP programs are looked
/// up on that, with the bridge's own and the usual prefixes behind it.
async fn search_path() -> &'static str {
    SEARCH_PATH
        .get_or_init(|| async {
            let own = std::env::var("PATH").unwrap_or_default();
            if cfg!(not(unix)) {
                return own;
            }
            let shell = shell_path().await.unwrap_or_default();
            merge(&[&shell, &own, FALLBACK_PATH])
        })
        .await
}

/// Ask `$SHELL` what its `PATH` is.
///
/// `-l` reads the login files and `-i` the interactive ones, because an export
/// is as likely to sit in `~/.zshrc` as in `~/.zprofile`. Startup files print
/// things — greetings, version managers, prompt preambles — so the value comes
/// back between markers rather than as the whole of stdout, and stdin is closed
/// so a shell that decides to ask something cannot hang the bridge.
#[cfg(unix)]
async fn shell_path() -> Option<String> {
    const MARK: &str = "__ivx_path__";

    let shell = std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty())?;
    let script = format!("printf '%s%s%s' '{MARK}' \"$PATH\" '{MARK}'");
    let out = tokio::time::timeout(
        SHELL_TIMEOUT,
        tokio::process::Command::new(&shell)
            .args(["-lic", &script])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;

    let text = String::from_utf8_lossy(&out.stdout);
    let (_, rest) = text.split_once(MARK)?;
    let (path, _) = rest.split_once(MARK)?;
    Some(path.trim().to_string())
}

#[cfg(not(unix))]
async fn shell_path() -> Option<String> {
    None // nothing to ask: a Windows process is started with the user's PATH
}

/// One `PATH` out of several, in order, without repeats.
fn merge(paths: &[&str]) -> String {
    let mut dirs: Vec<&str> = Vec::new();
    for dir in paths.iter().flat_map(|path| path.split(':')) {
        if !dir.is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

/// Find `command` the way a shell would: a name is looked for in each
/// directory of `path`, and anything with a slash in it is a path already and
/// is handed to the spawn as given, so the spawn can report what is wrong.
fn resolve(command: &str, path: &str) -> Option<PathBuf> {
    if cfg!(not(unix)) || command.contains('/') {
        return Some(PathBuf::from(command));
    }
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| Path::new(dir).join(command))
        .find(|candidate| runnable(candidate))
}

/// A file that exists and can be executed — not a directory that shares the
/// name, and not a file sitting there without its bit set.
fn runnable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

struct Session {
    child: Child,
    stdin: ChildStdin,
    /// Kept as a `Lines` reader because that is the only way stdout is read:
    /// MCP frames are newline-delimited JSON, one message per line.
    lines: Lines<BufReader<ChildStdout>>,
    last_used: Instant,
}

/// Every live stdio MCP process, keyed by a random session id.
#[derive(Default)]
pub struct McpSessions(Mutex<HashMap<String, Session>>);

impl McpSessions {
    /// Kill sessions idle past the cutoff, and sessions whose process already
    /// exited on its own. Called on the way into every request; nothing here
    /// needs its own task.
    async fn reap(&self) {
        let mut sessions = self.0.lock().await;
        // Taken out wholesale so every child can be examined mutably; the ones
        // still alive and in use go back.
        let all: Vec<(String, Session)> = sessions.drain().collect();
        for (id, mut session) in all {
            if session.last_used.elapsed() >= SESSION_IDLE {
                let _ = session.child.kill().await;
                continue;
            }
            if matches!(session.child.try_wait(), Ok(Some(_))) {
                continue; // the process ended on its own; nothing to reap
            }
            sessions.insert(id, session);
        }
    }
}

pub async fn handle(state: &State, req: Request<Incoming>, origin: Option<&str>) -> Response<Body> {
    state.mcp.reap().await;

    let (_, body) = req.into_parts();
    let bytes = match Limited::new(body, MAX_BODY).collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(_) => {
            return json_error(
                state,
                StatusCode::PAYLOAD_TOO_LARGE,
                "Request body is too large.",
                origin,
            )
        }
    };
    let msg: Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(err) => {
            return json_error(
                state,
                StatusCode::BAD_REQUEST,
                &format!("Body is not JSON: {err}"),
                origin,
            )
        }
    };

    match msg.get("action").and_then(Value::as_str) {
        Some("start") => start(state, &msg, origin).await,
        Some("send") => send(state, &msg, origin).await,
        Some("stop") => stop(state, &msg, origin).await,
        _ => json_error(
            state,
            StatusCode::BAD_REQUEST,
            "Body must name an action: start, send or stop.",
            origin,
        ),
    }
}

fn wanted<'a>(msg: &'a Value, key: &str) -> Option<&'a Value> {
    msg.get(key).filter(|v| !v.is_null())
}

async fn start(state: &State, msg: &Value, origin: Option<&str>) -> Response<Body> {
    let command = match wanted(msg, "command").and_then(Value::as_str) {
        Some(c) if !c.trim().is_empty() => c.trim().to_string(),
        _ => {
            return json_error(
                state,
                StatusCode::BAD_REQUEST,
                "start needs a `command` to run.",
                origin,
            )
        }
    };
    let args: Vec<String> = wanted(msg, "args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(String::from)
                .collect()
        })
        .unwrap_or_default();
    let env: Vec<(String, String)> = wanted(msg, "env")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();

    let mut map = state.mcp.0.lock().await;
    if map.len() >= MAX_SESSIONS {
        return json_error(
            state,
            StatusCode::TOO_MANY_REQUESTS,
            "Too many MCP sessions are already running. Stop one first.",
            origin,
        );
    }

    // A configured server names a program (`npx`, `uvx`), and the bridge's own
    // `PATH` is a service's, which knows none of them; see `search_path`. A
    // server that carries its own `PATH` meant it, and keeps it.
    let path = match env.iter().find(|(key, _)| key == "PATH") {
        Some((_, given)) => given.clone(),
        None => search_path().await.to_string(),
    };
    let Some(program) = resolve(&command, &path) else {
        // The PATH searched belongs in the log, not in a message box: it is a
        // paragraph of directories, and it is what a person debugging this
        // wants to read.
        state.log(&format!("mcp start `{command}` not found on {path}"));
        return json_error(
            state,
            StatusCode::BAD_GATEWAY,
            &format!(
                "Could not find `{command}` on this machine. Give the full \
                 path to the program, or put its folder on PATH. The bridge \
                 log lists where it looked."
            ),
            origin,
        );
    };

    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args)
        .envs(env)
        // The program's own children need to be found too: `npx` runs `node`.
        .env("PATH", &path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Reaping is best-effort housekeeping; this is the backstop that keeps
        // a dropped session from leaving an orphan behind.
        .kill_on_drop(true);

    let spawned = cmd.spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => {
            return json_error(
                state,
                StatusCode::BAD_GATEWAY,
                &format!("Could not start `{command}`: {err}"),
                origin,
            )
        }
    };
    // stderr is drained so a chatty server cannot fill its pipe and freeze.
    if let Some(stderr) = child.stderr.take() {
        let command = command.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("mcp[{command}] {line}");
            }
        });
    }
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            return json_error(
                state,
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not attach to the process stdin.",
                origin,
            )
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => BufReader::new(stdout).lines(),
        None => {
            return json_error(
                state,
                StatusCode::INTERNAL_SERVER_ERROR,
                "Could not attach to the process stdout.",
                origin,
            );
        }
    };

    let id = crate::random_token();
    map.insert(
        id.clone(),
        Session {
            child,
            stdin,
            lines: stdout,
            last_used: Instant::now(),
        },
    );
    state.log(&format!("mcp start `{command}` -> {id}"));

    reply(json!({ "ok": true, "sessionId": id }), origin)
}

async fn send(state: &State, msg: &Value, origin: Option<&str>) -> Response<Body> {
    let session_id = match wanted(msg, "sessionId").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => id.to_string(),
        _ => {
            return json_error(
                state,
                StatusCode::BAD_REQUEST,
                "send needs the `sessionId` to deliver to.",
                origin,
            );
        }
    };
    let message = match wanted(msg, "message") {
        Some(m) if m.is_object() => m.clone(),
        _ => {
            return json_error(
                state,
                StatusCode::BAD_REQUEST,
                "send needs a `message` JSON-RPC object.",
                origin,
            );
        }
    };

    let mut map = state.mcp.0.lock().await;
    let Some(session) = map.get_mut(&session_id) else {
        return json_error(
            state,
            StatusCode::NOT_FOUND,
            "Unknown session — the server was stopped or reaped. Start it again.",
            origin,
        );
    };
    session.last_used = Instant::now();

    let mut wire = serde_json::to_vec(&message).unwrap_or_default();
    wire.push(b'\n');
    if let Err(err) = session.stdin.write_all(&wire).await {
        return json_error(
            state,
            StatusCode::BAD_GATEWAY,
            &format!("The process stopped accepting input: {err}"),
            origin,
        );
    }
    if let Err(err) = session.stdin.flush().await {
        return json_error(
            state,
            StatusCode::BAD_GATEWAY,
            &format!("The process stopped accepting input: {err}"),
            origin,
        );
    }

    // A notification wants no answer: it is fire-and-forget by design.
    let id = message.get("id");
    let Some(id) = id else {
        return reply(json!({ "ok": true, "response": Value::Null }), origin);
    };

    let response = loop {
        let line = match tokio::time::timeout(SEND_TIMEOUT, session.lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => {
                return json_error(
                    state,
                    StatusCode::BAD_GATEWAY,
                    "The process closed its output before answering.",
                    origin,
                );
            }
            Ok(Err(err)) => {
                return json_error(
                    state,
                    StatusCode::BAD_GATEWAY,
                    &format!("Lost the process output: {err}"),
                    origin,
                );
            }
            Err(_) => {
                return json_error(
                    state,
                    StatusCode::GATEWAY_TIMEOUT,
                    "The process did not answer in time. It may still be busy; try again.",
                    origin,
                );
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(candidate) = serde_json::from_str::<Value>(&line) else {
            continue; // non-JSON chatter on stdout is skipped, not fatal
        };
        // The answer to this message is the one sharing its id. Notifications
        // (no id) and server-initiated requests (id plus a method we do not
        // answer) pass by without matching.
        if candidate.get("id") == Some(id) && candidate.get("method").is_none() {
            break candidate;
        }
    };

    reply(json!({ "ok": true, "response": response }), origin)
}

async fn stop(state: &State, msg: &Value, origin: Option<&str>) -> Response<Body> {
    let session_id = wanted(msg, "sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if session_id.is_empty() {
        return json_error(
            state,
            StatusCode::BAD_REQUEST,
            "stop needs the `sessionId` to stop.",
            origin,
        );
    }
    if let Some(mut session) = state.mcp.0.lock().await.remove(session_id) {
        let _ = session.child.kill().await;
        state.log(&format!("mcp stop {session_id}"));
    }
    reply(json!({ "ok": true }), origin)
}

/// A successful reply, shaped like the errors: JSON, not cached, CORS-open.
fn reply(body: Value, origin: Option<&str>) -> Response<Body> {
    let mut res = Response::new(crate::full(
        serde_json::to_string(&body).unwrap_or_else(|_| r#"{"ok":false}"#.into()),
    ));
    res.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        hyper::header::HeaderValue::from_static("application/json"),
    );
    crate::cors::allow(res.headers_mut(), origin);
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_keeps_order_and_drops_repeats() {
        assert_eq!(merge(&["/a:/b", "/b:/c", ""]), "/a:/b:/c");
        assert_eq!(merge(&["", "::/a::"]), "/a");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_finds_a_name_on_the_path() {
        // `sh` is the one program every Unix has, in a place every Unix has.
        assert_eq!(
            resolve("sh", "/nowhere:/bin"),
            Some(PathBuf::from("/bin/sh"))
        );
        assert_eq!(resolve("sh", "/nowhere"), None);
        // A directory of the right name is not a program.
        assert_eq!(resolve("tmp", "/"), None);
    }

    #[test]
    fn resolve_leaves_a_path_alone() {
        // Handed on as given, missing or not, so the spawn reports the reason.
        assert_eq!(
            resolve("/opt/does-not-exist/server", ""),
            Some(PathBuf::from("/opt/does-not-exist/server"))
        );
    }

    #[test]
    fn session_idle_reaps_nothing_fresh() {
        // The reaper is exercised through handle(); this just pins the const
        // to a value a person could sit through.
        assert!(SESSION_IDLE <= Duration::from_secs(30 * 60));
        assert!(SEND_TIMEOUT >= Duration::from_secs(30));
    }
}
