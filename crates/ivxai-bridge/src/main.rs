// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

//! `ivxai-bridge` — the standalone daemon.
//!
//! This is the whole "you do not have to install an app" path: one binary,
//! a few megabytes, no window, no runtime. Install it, leave it running, and
//! the hosted ivx/ai Chat can reach endpoints that would otherwise refuse a
//! browser.
//!
//! Argument parsing is by hand. A dependency for it would be larger than the
//! server, and the surface is nine flags.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use ivxai_bridge::{cors, BoxError, Config, OriginPolicy, OriginRule, State, DEFAULT_PORT};

const USAGE: &str = "\
ivxai-bridge — let a browser reach endpoints that do not speak CORS

USAGE
  ivxai-bridge [options]

OPTIONS
  -p, --port <port>        Port to listen on (default 8787)
      --host <addr>        Address to bind (default 127.0.0.1)
      --allow-origin <o>   Also accept this browser origin (repeatable)
      --only-origin <o>    Accept only the origins given this way (repeatable)
      --allow-any-origin   Accept every origin. Development only
      --token <secret>     Require this token on /proxy, as ?token= or
                           X-Ivx-Token. For shared machines
      --ui-dir <dir>       Also serve a built copy of ivx/ai Chat from here.
                           Needed on Safari, which blocks http://127.0.0.1
                           from an HTTPS page
      --insecure           Do not verify TLS upstream. Local self-signed
                           certificates only
      --connect-timeout <s>  Seconds to wait for a connection (default 30)
  -v, --verbose            Log one line per request: method, host, status.
                           Never headers, never bodies
      --install-service    Install and start a login service with these same
                           options (launchd on macOS, systemd --user on Linux)
      --uninstall-service  Stop and remove it
  -h, --help               This text
  -V, --version            Version

BY DEFAULT it accepts https://ai.ivx.run, https://o.eval.blog, any
loopback origin, and the Tauri webview origins. Anything else is refused: the
browser sets Origin and a page cannot forge it, so that list is what stops a
site you happen to visit from using the bridge to reach your own network.

It also exposes /mcp/stdio, which starts a local MCP server (a program) and
pipes JSON-RPC to its stdin/stdout on the page's behalf. Access to the bridge
is therefore access to your machine: keep the token, if you use one, close.
";

struct Args {
    host: IpAddr,
    port: u16,
    extra_origins: Vec<String>,
    only_origins: Vec<String>,
    any_origin: bool,
    token: Option<String>,
    ui_dir: Option<PathBuf>,
    insecure: bool,
    connect_timeout: Duration,
    verbose: bool,
    service: Option<ServiceAction>,
}

#[derive(PartialEq)]
enum ServiceAction {
    Install,
    Uninstall,
}

fn parse_args() -> Result<Option<Args>, BoxError> {
    let mut args = Args {
        host: IpAddr::from([127, 0, 0, 1]),
        port: DEFAULT_PORT,
        extra_origins: Vec::new(),
        only_origins: Vec::new(),
        any_origin: false,
        token: None,
        ui_dir: None,
        insecure: false,
        connect_timeout: Duration::from_secs(30),
        verbose: false,
        service: None,
    };

    let mut raw = std::env::args().skip(1);
    while let Some(arg) = raw.next() {
        let mut value = || {
            raw.next()
                .ok_or_else(|| BoxError::from(format!("{arg} needs a value")))
        };
        match arg.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return Ok(None);
            }
            "-V" | "--version" => {
                println!("ivxai-bridge {}", ivxai_bridge::VERSION);
                return Ok(None);
            }
            "-p" | "--port" => args.port = value()?.parse()?,
            "--host" => args.host = value()?.parse()?,
            "--allow-origin" => args.extra_origins.push(value()?),
            "--only-origin" => args.only_origins.push(value()?),
            "--allow-any-origin" => args.any_origin = true,
            "--token" => args.token = Some(value()?),
            "--ui-dir" => args.ui_dir = Some(PathBuf::from(value()?)),
            "--insecure" => args.insecure = true,
            "--connect-timeout" => args.connect_timeout = Duration::from_secs(value()?.parse()?),
            "-v" | "--verbose" => args.verbose = true,
            "--install-service" => args.service = Some(ServiceAction::Install),
            "--uninstall-service" => args.service = Some(ServiceAction::Uninstall),
            other => {
                return Err(format!("Unknown option `{other}`. Try --help.").into());
            }
        }
    }
    Ok(Some(args))
}

fn policy(args: &Args) -> OriginPolicy {
    if args.any_origin {
        return OriginPolicy::Any;
    }
    if !args.only_origins.is_empty() {
        return OriginPolicy::List(
            args.only_origins
                .iter()
                .map(|o| OriginRule::Exact(o.clone()))
                .collect(),
        );
    }
    let mut rules = cors::default_rules();
    rules.extend(
        args.extra_origins
            .iter()
            .map(|o| OriginRule::Exact(o.clone())),
    );
    OriginPolicy::List(rules)
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(err) = run().await {
        eprintln!("ivxai-bridge: {err}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), BoxError> {
    let Some(args) = parse_args()? else {
        return Ok(());
    };

    match args.service {
        Some(ServiceAction::Install) => return service::install(),
        Some(ServiceAction::Uninstall) => return service::uninstall(),
        None => {}
    }

    if let Some(dir) = &args.ui_dir {
        if !dir.join("index.html").is_file() {
            return Err(format!(
                "--ui-dir {} has no index.html in it. Point it at a built copy of the app \
                 (`npm run build` leaves one in dist/).",
                dir.display()
            )
            .into());
        }
    }
    if args.any_origin {
        eprintln!(
            "ivxai-bridge: --allow-any-origin means any page in your browser can use this \
             bridge to reach your network. Development only."
        );
    }
    if !args.host.is_loopback() && args.token.is_none() {
        eprintln!(
            "ivxai-bridge: binding {} exposes the bridge beyond this machine. Use --token \
             unless you are certain.",
            args.host
        );
    }

    let addr = SocketAddr::new(args.host, args.port);
    let config = Config {
        origins: policy(&args),
        token: args.token,
        ui_dir: args.ui_dir,
        connect_timeout: args.connect_timeout,
        insecure: args.insecure,
        verbose: args.verbose,
    };

    let listener = tokio::net::TcpListener::bind(addr).await.map_err(|err| {
        if err.kind() == std::io::ErrorKind::AddrInUse {
            format!("{addr} is already in use — another bridge is probably running. Use --port.")
        } else {
            format!("Cannot bind {addr}: {err}")
        }
    })?;

    println!("ivxai-bridge {} on http://{addr}", ivxai_bridge::VERSION);
    println!("  accepting: {}", config.origins.describe());
    if config.token.is_some() {
        println!("  token:     required");
    }
    match &config.ui_dir {
        Some(dir) => println!("  serving:   {} — open http://{addr}/", dir.display()),
        None => {
            println!("  connect:   ivx/ai Chat -> Settings -> CORS bypass -> Look for the bridge")
        }
    }

    let state = Arc::new(State::new(config)?);
    tokio::select! {
        result = ivxai_bridge::serve(listener, state) => result,
        _ = tokio::signal::ctrl_c() => {
            println!("\nstopped");
            Ok(())
        }
    }
}

/// Installing the daemon so it comes back after a reboot.
///
/// launchd and systemd already know how to keep a process alive and restart
/// it; forking ourselves into the background would mean reimplementing that
/// badly and losing the logs.
mod service {
    use super::BoxError;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::path::PathBuf;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::process::Command;

    // Only launchd labels its job this way; the systemd unit is named by its
    // filename and Windows has no service path at all.
    #[cfg(target_os = "macos")]
    const LABEL: &str = "run.ivx.bridge";

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn home() -> Result<PathBuf, BoxError> {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or_else(|| "HOME is not set".into())
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn exe() -> Result<String, BoxError> {
        Ok(std::env::current_exe()?.to_string_lossy().into_owned())
    }

    /// The options this invocation was given, minus the install flag itself —
    /// so `--install-service --port 9000 -v` installs a service on port 9000.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn passthrough_args() -> Vec<String> {
        std::env::args()
            .skip(1)
            .filter(|a| a != "--install-service" && a != "--uninstall-service")
            .collect()
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn run(program: &str, args: &[&str]) -> Result<(), BoxError> {
        let status = Command::new(program).args(args).status()?;
        if !status.success() {
            return Err(format!("`{program} {}` failed ({status})", args.join(" ")).into());
        }
        Ok(())
    }

    #[cfg(target_os = "macos")]
    fn unit_path() -> Result<PathBuf, BoxError> {
        Ok(home()?.join(format!("Library/LaunchAgents/{LABEL}.plist")))
    }

    #[cfg(target_os = "macos")]
    pub fn install() -> Result<(), BoxError> {
        let path = unit_path()?;
        std::fs::create_dir_all(path.parent().expect("plist has a parent"))?;

        let mut program_args = vec![exe()?];
        program_args.extend(passthrough_args());
        let xml: String = program_args
            .iter()
            .map(|a| format!("    <string>{}</string>\n", xml_escape(a)))
            .collect();
        let logs = home()?.join("Library/Logs");
        std::fs::create_dir_all(&logs)?;

        std::fs::write(
            &path,
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{xml}  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{log}/ivxai-bridge.log</string>
  <key>StandardErrorPath</key><string>{log}/ivxai-bridge.log</string>
</dict>
</plist>
"#,
                log = logs.display(),
            ),
        )?;

        let target = format!("gui/{}", unsafe { libc_getuid() });
        // Already loaded from a previous install? Take it out first; bootstrap
        // refuses to replace a live service.
        let _ = Command::new("launchctl")
            .args(["bootout", &format!("{target}/{LABEL}")])
            .status();
        let plist = path.to_string_lossy().into_owned();
        run("launchctl", &["bootstrap", target.as_str(), plist.as_str()])?;

        println!("Installed {}", path.display());
        println!("Logs: {}/ivxai-bridge.log", logs.display());
        println!("Running now, and again at every login.");
        Ok(())
    }

    #[cfg(target_os = "macos")]
    pub fn uninstall() -> Result<(), BoxError> {
        let path = unit_path()?;
        let target = format!("gui/{}/{LABEL}", unsafe { libc_getuid() });
        let _ = Command::new("launchctl")
            .args(["bootout", &target])
            .status();
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        println!("Removed {}", path.display());
        Ok(())
    }

    /// One libc call, not worth a dependency.
    #[cfg(target_os = "macos")]
    unsafe fn libc_getuid() -> u32 {
        unsafe extern "C" {
            fn getuid() -> u32;
        }
        getuid()
    }

    #[cfg(target_os = "macos")]
    fn xml_escape(s: &str) -> String {
        s.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    }

    #[cfg(target_os = "linux")]
    fn unit_path() -> Result<PathBuf, BoxError> {
        Ok(home()?.join(".config/systemd/user/ivxai-bridge.service"))
    }

    #[cfg(target_os = "linux")]
    pub fn install() -> Result<(), BoxError> {
        let path = unit_path()?;
        std::fs::create_dir_all(path.parent().expect("unit has a parent"))?;

        let command = std::iter::once(exe()?)
            .chain(passthrough_args())
            .map(|a| format!("{a:?}")) // systemd accepts C-style quoting
            .collect::<Vec<_>>()
            .join(" ");

        std::fs::write(
            &path,
            format!(
                "[Unit]\n\
                 Description=ivx/ai Chat bridge\n\
                 Documentation=https://github.com/ivxlabs/ivxai-app\n\
                 After=network-online.target\n\
                 \n[Service]\n\
                 ExecStart={command}\n\
                 Restart=on-failure\n\
                 RestartSec=2\n\
                 \n[Install]\n\
                 WantedBy=default.target\n"
            ),
        )?;

        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "enable", "--now", "ivxai-bridge"])?;
        println!("Installed {}", path.display());
        println!("Logs: journalctl --user -u ivxai-bridge -f");
        Ok(())
    }

    #[cfg(target_os = "linux")]
    pub fn uninstall() -> Result<(), BoxError> {
        let path = unit_path()?;
        let _ = run("systemctl", &["--user", "disable", "--now", "ivxai-bridge"]);
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        let _ = run("systemctl", &["--user", "daemon-reload"]);
        println!("Removed {}", path.display());
        Ok(())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn install() -> Result<(), BoxError> {
        Err(unsupported())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    pub fn uninstall() -> Result<(), BoxError> {
        Err(unsupported())
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    fn unsupported() -> BoxError {
        "--install-service only knows launchd and systemd. On Windows, run \
         `schtasks /create /tn IvxAiBridge /sc onlogon /tr \"<path to \
         ivxai-bridge.exe>\"`, or drop a shortcut in shell:startup."
            .into()
    }
}
