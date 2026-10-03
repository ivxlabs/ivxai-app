#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Installs the built extension into a throwaway profile of a real browser and
// checks that it does the thing it exists to do.
//
//   node scripts/extension-test.mjs                  Chrome and Firefox
//   node scripts/extension-test.mjs firefox          just that one
//   node scripts/extension-test.mjs --headed         watch it happen
//
// Safari is not here: what Safari installs is a signed app, built by Xcode and
// enabled by hand in the Develop menu, so it cannot be driven from a script.
// packaging/extension/README.md says what to do by hand instead.
//
// The claim under test is narrow and worth stating: once a host has been
// allowed, an extension page reaches an endpoint that sends no CORS headers,
// where an ordinary page cannot. Three halves, really, all against the same
// server — the mock provider started with --no-cors — because only the set is
// evidence. A fetch that succeeds from the extension proves nothing if the
// endpoint was permissive all along, and a permission model proves nothing if
// the permission was never needed: so the run checks that the endpoint is out
// of reach before the grant, in reach after it, and out of reach from an
// ordinary page throughout.
//
// The two browsers need entirely different machinery to get an extension
// installed and a privileged page open, which is most of the length here:
//
//   Chrome    Released Chrome refuses --load-extension outright, so the
//             extension goes in over CDP, with Extensions.loadUnpacked.
//   Firefox   Marionette installs it and opens the tab, because WebDriver BiDi
//             declines to navigate a content tab to moz-extension:, and the two
//             cannot both hold a session at once.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = join(root, 'packaging', 'extension', 'build');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox';

const MOCK_PORT = 8124;    // the endpoint that sends no CORS headers
const CONTROL_PORT = 8125; // a plain page on a different origin, to be refused
const ECHO_PORT = 8127;    // reports the Origin it was sent, to anyone

const headed = process.argv.includes('--headed');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Refuse to run against a server we did not start.
 *
 * Every endpoint here is a fixture with specific behaviour — no CORS headers,
 * 403 to any Origin — and something else already listening on the port answers
 * the probe just as well while behaving nothing like it. That does not fail the
 * run, it quietly passes it: a check that should have caught a missing header
 * rule instead talks to a permissive server and reports ok. Which is worse than
 * a red run, so this stops first.
 */
function insistPortIsFree(port, what) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error(
      `something is already listening on ${port} — ${what} cannot start. ` +
      'Stop it (`pkill -f mock-provider`) and run again.')));
    probe.once('listening', () => probe.close(() => resolve()));
    probe.listen(port, '127.0.0.1');
  });
}

async function waitFor(fn, { tries = 60, every = 250 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch { /* not up yet */ }
    await sleep(every);
  }
  return null;
}

/* ── CDP, for Chrome ───────────────────────────────────────── */

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => (${expression}))()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || 'evaluation failed');
    }
    return res.result.value;
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

/* ── Marionette, for Firefox ───────────────────────────────── */

/* Length-prefixed JSON over a socket: `27:[0,1,"WebDriver:NewSession",{}]`.
   Commands go out as [0, id, name, params] and come back as [1, id, error,
   result]; the first thing the server says is an unsolicited handshake. */
class Marionette {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.onHandshake = null;
    sock.on('data', d => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
  }

  drain() {
    for (;;) {
      const colon = this.buf.indexOf(0x3a);
      if (colon < 0) return;
      const len = Number(this.buf.subarray(0, colon).toString());
      if (!Number.isFinite(len)) return;
      const start = colon + 1;
      if (this.buf.length < start + len) return;
      const msg = JSON.parse(this.buf.subarray(start, start + len).toString());
      this.buf = this.buf.subarray(start + len);

      if (Array.isArray(msg) && msg[0] === 1) {
        const [, id, error, result] = msg;
        const waiter = this.pending.get(id);
        if (!waiter) continue;
        this.pending.delete(id);
        error ? waiter.reject(new Error(error.message || JSON.stringify(error)))
              : waiter.resolve(result);
      } else if (this.onHandshake) {
        this.onHandshake(msg);
        this.onHandshake = null;
      }
    }
  }

  static async connect(port) {
    const sock = await new Promise((resolve, reject) => {
      const s = createConnection({ host: '127.0.0.1', port }, () => resolve(s));
      s.on('error', reject);
    });
    const m = new Marionette(sock);
    await new Promise(r => { m.onHandshake = r; });
    return m;
  }

  send(name, params = {}) {
    const id = ++this.seq;
    const body = JSON.stringify([0, id, name, params]);
    this.sock.write(`${Buffer.byteLength(body)}:${body}`);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${name} timed out`));
      }, 30000);
    });
  }

  close() { this.sock.destroy(); }
}

/* ── drivers ───────────────────────────────────────────────── */

/**
 * Chrome: install over CDP, open the app, evaluate in it.
 *
 * Released Chrome ignores --load-extension and --disable-extensions-except
 * ("not allowed in Google Chrome"), which is why none of them appear here.
 * Extensions.loadUnpacked is the supported way in, and needs the browser
 * started with --enable-unsafe-extension-debugging.
 */
async function chromeDriver() {
  const ext = join(BUILD, 'chrome');
  if (!existsSync(CHROME)) throw new Error('Google Chrome is not installed where expected');
  if (!existsSync(ext)) throw new Error(`${ext} is missing — run \`npm run ext:build\``);

  /* Loaded from a copy of the build, never the build itself, because `grant`
     below rewrites the manifest. An unpacked extension's id is a hash of its
     path, so the copy keeps one id across the reload that granting needs. */
  const work = mkdtempSync(join(tmpdir(), 'ivx-chrome-ext-'));
  cpSync(ext, work, { recursive: true });

  const port = 9222;
  const profile = mkdtempSync(join(tmpdir(), 'ivx-chrome-'));
  const proc = spawn(CHROME, [
    `--user-data-dir=${profile}`,
    '--enable-unsafe-extension-debugging',
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    ...(headed ? [] : ['--headless=new']),
    'about:blank',
  ], { stdio: 'ignore' });

  const cdp = path => fetch(`http://127.0.0.1:${port}${path}`).then(r => r.json());
  const version = await waitFor(() => cdp('/json/version'));
  if (!version) throw new Error('Chrome never opened its debugging port');

  const browser = await CdpSession.open(version.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: work });

  const worker = await waitFor(async () => {
    const targets = await cdp('/json/list');
    return targets.find(t => t.url === `chrome-extension://${id}/background.js`);
  }, { tries: 20 });

  const newTab = async url => {
    const t = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
      { method: 'PUT' }).then(r => r.json());
    const s = await CdpSession.open(t.webSocketDebuggerUrl);
    await s.send('Runtime.enable');
    await s.send('Log.enable');
    return s;
  };

  let app = await newTab(`chrome-extension://${id}/index.html`);

  return {
    label: version.Browser,
    id,
    scheme: 'chrome-extension:',
    backgroundStarted: Boolean(worker),
    /* `permissions.request()` opens a browser dialog, and nothing in CDP can
       answer it — the Extensions domain grants no permissions, and there is no
       switch that auto-accepts. So the *granted state* is reproduced the only
       other way Chrome offers: the same package, with those hosts declared,
       reloaded from the same path. What that leaves untested here is Chrome's
       own dialog, which is the browser's code and not ours; the Firefox run
       goes through the real request and covers the round trip. */
    grantNote: 'by declaring the host and reloading — Chrome’s prompt cannot be scripted',
    grant: async origins => {
      const manifestPath = join(work, 'manifest.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.host_permissions = origins;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      app.close();
      await browser.send('Extensions.uninstall', { id });
      const again = await browser.send('Extensions.loadUnpacked', { path: work });
      if (again.id !== id) throw new Error(`the reload changed the id: ${id} -> ${again.id}`);
      await waitFor(async () => (await cdp('/json/list'))
        .find(t => t.url === `chrome-extension://${id}/background.js`), { tries: 20 });
      app = await newTab(`chrome-extension://${id}/index.html`);
      await waitFor(() => app.eval('Boolean(document.querySelector("#composer"))'));
      return app.eval(`chrome.permissions.getAll().then(
        p => (p.origins ?? []).some(o => ${JSON.stringify(origins)}.includes(o)))`);
    },
    eval: expr => app.eval(expr),
    evalOnPlainPage: async expr => {
      const page = await newTab(`http://127.0.0.1:${CONTROL_PORT}/`);
      try { return await page.eval(expr); } finally { page.close(); }
    },
    consoleErrors: () => app.events
      .filter(e => e.method === 'Log.entryAdded' && e.params.entry.level === 'error')
      .map(e => e.params.entry.text),
    stop: async () => {
      app.close();
      browser.close();
      proc.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    },
  };
}

/**
 * Firefox: everything over Marionette.
 *
 * BiDi cannot do it: `browsingContext.navigate` refuses a moz-extension: URL
 * from a content context ("not allowed in this context"). Marionette can,
 * because it will run script in the parent process, where opening a privileged
 * tab is allowed. The two cannot be combined either — Firefox permits one
 * WebDriver session at a time — so the console is read the privileged way too,
 * off nsIConsoleService, which is where uncaught errors and CSP violations
 * both land.
 */
async function firefoxDriver() {
  const ext = join(BUILD, 'firefox');
  if (!existsSync(FIREFOX)) throw new Error('Firefox is not installed where expected');
  if (!existsSync(ext)) throw new Error(`${ext} is missing — run \`npm run ext:build\``);

  const marionettePort = 2829;
  const profile = mkdtempSync(join(tmpdir(), 'ivx-firefox-'));
  // Pinned in the profile rather than left on the default 2828, so a Firefox
  // already running on this machine is never the one we talk to.
  writeFileSync(join(profile, 'user.js'), [
    `user_pref("marionette.port", ${marionettePort});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("browser.aboutwelcome.enabled", false);',
    /* The optional-permission doorhanger. Suppressed so `permissions.request`
       resolves on its own; the user gesture it also requires is real, and is
       supplied by an actual click below. */
    'user_pref("extensions.webextOptionalPermissionPrompts", false);',
  ].join('\n') + '\n');

  const proc = spawn(FIREFOX, [
    '--profile', profile,
    '--marionette',
    // Opening a privileged tab means running script in the parent process.
    '--remote-allow-system-access',
    '--no-remote',
    ...(headed ? [] : ['--headless']),
    'about:blank',
  ], { stdio: 'ignore' });

  const mar = await waitFor(() => Marionette.connect(marionettePort), { tries: 60, every: 500 });
  if (!mar) throw new Error('Firefox never opened its Marionette port');
  const session = await mar.send('WebDriver:NewSession', {});
  await mar.send('WebDriver:SetTimeouts', { script: 30000 });

  const addonId = (await mar.send('Addon:Install', { path: ext, temporary: true })).value;

  // Firefox gives each extension a per-profile UUID and that, not the add-on
  // id, is what moz-extension: URLs are built from. It is kept in a pref.
  await mar.send('Marionette:SetContext', { value: 'chrome' });
  const uuids = JSON.parse((await mar.send('WebDriver:ExecuteScript', {
    script: 'return Services.prefs.getStringPref("extensions.webextensions.uuids");',
    args: [],
  })).value);
  const uuid = uuids[addonId];
  if (!uuid) throw new Error(`no moz-extension UUID was assigned to ${addonId}`);
  const pageUrl = `moz-extension://${uuid}/index.html`;

  /* The tabs that exist before the app is opened. Identifying tabs by when
     they appeared, rather than by their URL, is the only thing that holds here:
     the sidebar panel and the app tab are both
     `moz-extension://<uuid>/index.html`, so a URL match cannot tell them apart,
     and switching to the wrong one made every check measure a document it was
     not running in. */
  const handlesNow = async () => {
    // GetWindowHandles answers with a bare array, where most commands answer
    // with { value }.
    const raw = await mar.send('WebDriver:GetWindowHandles');
    return Array.isArray(raw) ? raw : (raw?.value ?? []);
  };
  /* Counted in the content context on purpose. In the chrome context the same
     command answers with browser *windows*, which share no ids with content
     tabs — so every tab looks new and the first one wins. */
  await mar.send('Marionette:SetContext', { value: 'content' });
  const before = await handlesNow();
  await mar.send('Marionette:SetContext', { value: 'chrome' });

  // The background page is where the toolbar button would have opened this
  // from, and the parent process is the only place allowed to.
  await mar.send('WebDriver:ExecuteScript', {
    script: `
      const win = Services.wm.getMostRecentWindow("navigator:browser");
      win.gBrowser.selectedTab = win.gBrowser.addTab(arguments[0], {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return true;`,
    args: [pageUrl],
  });
  await mar.send('Marionette:SetContext', { value: 'content' });

  const evalIn = async expr => {
    const res = await mar.send('WebDriver:ExecuteAsyncScript', {
      script: `const done = arguments[arguments.length - 1];
        (async () => (${expr}))().then(done, e => done({ __threw: String(e) }));`,
      args: [],
    });
    const value = res.value;
    if (value && typeof value === 'object' && value.__threw) throw new Error(value.__threw);
    return value;
  };

  const use = handle => mar.send('WebDriver:SwitchToWindow', { handle });

  // The one tab that was not there a moment ago is the app.
  const appHandle = await waitFor(async () =>
    (await handlesNow()).find(h => !before.includes(h)) ?? null, { tries: 40 });
  if (!appHandle) throw new Error('the extension page never opened');
  await use(appHandle);

  // A tab Firefox already had becomes the ordinary-page control, so no tab is
  // opened or closed again for the rest of the run.
  const controlHandle = before[0];
  let controlReady = false;

  return {
    label: `Firefox ${session.capabilities?.browserVersion ?? ''}`.trim(),
    id: addonId,
    scheme: 'moz-extension:',
    backgroundStarted: Boolean(addonId),
    /* The real thing: `permissions.request()` off a click the browser counts
       as user input. Marionette's ExecuteScript carries no activation, so the
       request is wired to a button and the button is clicked — which is what a
       person does in Settings → Providers → Allow access. */
    grantNote: 'by permissions.request() from a real click',
    grant: async origins => {
      await use(appHandle);
      await evalIn(`(() => {
        const b = document.createElement('button');
        b.id = '__grant';
        b.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
        b.addEventListener('click', () => {
          (globalThis.browser ?? globalThis.chrome).permissions
            .request({ origins: ${JSON.stringify(origins)} })
            .then(r => { window.__granted = r; }, e => { window.__granted = 'THREW: ' + e.message; });
        });
        document.body.appendChild(b);
        return true;
      })()`);
      const found = await mar.send('WebDriver:FindElement', {
        using: 'css selector', value: '#__grant',
      });
      /* Marionette wraps some answers in { value } and hands others back bare.
         The element reference is under the W3C key — a fixed UUID whose exact
         spelling has moved between versions — so the one property the object
         has is taken rather than a constant that can go stale. */
      const box = found?.value ?? found ?? {};
      const ref = Object.values(box)[0];
      if (typeof ref !== 'string') throw new Error(`no element reference in ${JSON.stringify(found)}`);
      await mar.send('WebDriver:ElementClick', { id: ref });
      const answer = await waitFor(async () => {
        const v = await evalIn('window.__granted ?? null');
        return v === null ? null : { v };
      }, { tries: 40, every: 250 });
      await evalIn(`(() => { document.getElementById('__grant')?.remove(); return true; })()`);
      return answer?.v ?? null;
    },
    eval: async expr => { await use(appHandle); return evalIn(expr); },
    evalOnPlainPage: async expr => {
      await use(controlHandle);
      if (!controlReady) {
        await mar.send('WebDriver:Navigate', { url: `http://127.0.0.1:${CONTROL_PORT}/` });
        controlReady = true;
      }
      return evalIn(expr);
    },
    /* nsIConsoleService keeps the recent script errors for the whole browser,
       so this filters to the ones this extension's own pages raised. Warnings
       are dropped: flags bit 1 is the warning flag. */
    consoleErrors: async () => {
      await mar.send('Marionette:SetContext', { value: 'chrome' });
      try {
        const raw = (await mar.send('WebDriver:ExecuteScript', {
          script: `
            return (Services.console.getMessageArray() || []).map(m => {
              try {
                const e = m.QueryInterface(Ci.nsIScriptError);
                return { text: e.errorMessage, source: e.sourceName, flags: e.flags };
              } catch (_) {
                return { text: String(m.message ?? ''), source: '', flags: 0 };
              }
            });`,
          args: [],
        })).value ?? [];
        return raw
          .filter(e => (e.flags & 1) === 0)
          .filter(e => String(e.source).startsWith(`moz-extension://${uuid}`))
          .map(e => String(e.text));
      } finally {
        await mar.send('Marionette:SetContext', { value: 'content' }).catch(() => {});
        await use(appHandle).catch(() => {});
      }
    },
    stop: async () => {
      try { mar.close(); } catch { /* already gone */ }
      proc.kill();
      await sleep(300);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/* ── the checks themselves ─────────────────────────────────── */

async function runChecks(d, check) {
  check('the extension installs', Boolean(d.id), d.id);
  check('the background script starts', d.backgroundStarted);

  const booted = await waitFor(() =>
    d.eval('Boolean(document.querySelector("#composer") && document.querySelector("#convList"))'));
  check('the app boots on the extension origin', Boolean(booted));

  check(`it runs on a ${d.scheme} origin`, await d.eval('location.protocol') === d.scheme);

  /* Nothing is granted on install, and that is the point: the manifest asks
     for `optional_host_permissions`, so the browser shows no "read your data
     on all websites" on the way in and the extension starts out able to reach
     only what CORS already allows anyone to reach. */
  const declared = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).runtime.getManifest()`);
  check('no host permission is required on install',
    !declared.host_permissions?.length &&
    Boolean(declared.optional_host_permissions?.length),
    JSON.stringify({ required: declared.host_permissions ?? [],
                     optional: declared.optional_host_permissions ?? [] }));

  const held = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).permissions.getAll()
      .then(p => p.origins ?? [])`);
  check('nothing is granted yet', Array.isArray(held) && held.length === 0,
    JSON.stringify(held));

  /* Page tools ships content.js and declares nothing. The claim the manifest
     check above makes is only as good as this one: a content script in the
     manifest would carry its own host permissions, so "nothing is required on
     install" and "there is a content script" cannot both be true. */
  check('no content script is declared', !declared.content_scripts?.length,
    JSON.stringify(declared.content_scripts ?? []));

  /* `identity` is how an MCP server's OAuth redirect gets back to an
     extension. It is optional where the browser allows that, so an install
     that never connects such a server is never asked for it — and required on
     Firefox, which drops it from `optional_permissions` rather than honouring
     it. This checks the browser ended up with a usable one either way, which
     is the claim that matters: without it the sign-in cannot complete, and it
     would fail at the redirect rather than at the button. */
  const identityRequired = declared.permissions?.includes('identity');
  const identityOptional = declared.optional_permissions?.includes('identity');
  check('an MCP sign-in has a way to get back to the extension',
    Boolean(identityRequired || identityOptional),
    identityOptional ? 'optional, asked for on the click' : 'required by this browser');

  const registered = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).scripting.getRegisteredContentScripts()
      .then(list => list.map(s => s.id))`);
  check('page tools run nowhere until a site is allowed',
    Array.isArray(registered) && registered.length === 0, JSON.stringify(registered));

  /* And the `@` menu has nothing to offer, which is the same boundary seen
     from the other side: an open tab is mentionable only on a site page tools
     was allowed on, so with none allowed there is nothing to mention and
     nothing for the snapshot and screenshot tools to point at. The tab this
     very check runs in is open and is deliberately not in the list. */
  const mentionable = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).runtime
      .sendMessage({ type: 'ivx:tabs' }).then(r => r?.tabs ?? 'no answer')`);
  check('no tab can be mentioned until a site is allowed',
    Array.isArray(mentionable) && mentionable.length === 0, JSON.stringify(mentionable));

  // ── the actual point ─────────────────────────────────────
  const reach = `fetch('http://127.0.0.1:${MOCK_PORT}/v1/models')
      .then(r => r.json()).then(j => j.data?.[0]?.id ?? 'no models')
      .catch(e => 'BLOCKED: ' + e.message)`;

  // Ungranted, the extension is subject to the same CORS rule as any page.
  // Without this the grant below would prove nothing.
  const beforeGrant = await d.eval(reach);
  check('a CORS-less endpoint is out of reach before the grant',
    String(beforeGrant).startsWith('BLOCKED'), `got ${JSON.stringify(beforeGrant)}`);

  const allowed = await d.grant(['http://127.0.0.1/*']);
  check('the host can be granted', allowed === true, d.grantNote);

  /* And granting a host for a *provider* does not turn page tools on for it.
     The two grants come out of the same `<all_urls>` pool and are otherwise
     unrelated: a site page tools may run on is named in Settings → Page tools
     and nowhere else, so the registration stays empty here however many
     endpoints have been allowed. */
  const afterGrant = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).scripting.getRegisteredContentScripts()
      .then(list => list.map(s => s.id))`);
  check('allowing a provider host does not turn page tools on',
    Array.isArray(afterGrant) && afterGrant.length === 0, JSON.stringify(afterGrant));

  // Nor does it put a tab in the `@` menu, however many tabs are open on it.
  const stillNone = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).runtime
      .sendMessage({ type: 'ivx:tabs' }).then(r => r?.tabs ?? 'no answer')`);
  check('allowing a provider host does not make its tabs mentionable',
    Array.isArray(stillNone) && stillNone.length === 0, JSON.stringify(stillNone));

  const fromExtension = await waitFor(async () => {
    const got = await d.eval(reach);
    return got === 'mock-1' ? got : null;
  }, { tries: 12, every: 250 }) ?? await d.eval(reach);
  check('the extension page reaches a CORS-less endpoint once allowed',
    fromExtension === 'mock-1', `got ${JSON.stringify(fromExtension)}`);

  // The control. Same endpoint, ordinary page, and it must fail — otherwise
  // the check above proves only that the server was permissive.
  const fromPage = await d.evalOnPlainPage(reach);
  check('an ordinary page is still blocked by CORS',
    String(fromPage).startsWith('BLOCKED'), `got ${JSON.stringify(fromPage)}`);

  // ── streaming, which is how every reply arrives ──────────
  const streamed = await d.eval(`
    (async () => {
      const res = await fetch('http://127.0.0.1:${MOCK_PORT}/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mock-1', stream: true,
                               messages: [{ role: 'user', content: 'hi' }] }),
      });
      const reader = res.body.getReader();
      let chunks = 0;
      while (chunks < 3) {
        const { done } = await reader.read();
        if (done) break;
        chunks++;
      }
      reader.cancel();
      return chunks;
    })().catch(e => 'BLOCKED: ' + e.message)`);
  check('a streamed completion arrives in chunks',
    typeof streamed === 'number' && streamed >= 2, `read ${streamed} chunks`);

  /* The header half of the same problem, and the one CORS hides.

     A browser puts `Origin` on a cross-origin POST from an extension page just
     as it does from a web page, and a runtime that vets origins answers 403 —
     the request arrives and is refused, which no host permission prevents. The
     extension drops the header; this is what says so.

     It is checked with a POST because a GET does not carry an Origin at all,
     which is exactly why this went unnoticed: model lists worked. */
  const posted = await d.eval(`
    fetch('http://127.0.0.1:${MOCK_PORT}/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mock-1', messages: [{ role: 'user', content: 'hi' }] }),
    }).then(r => r.status).catch(e => 'THREW: ' + e.message)`);
  check('a POST is not turned away for its Origin', posted === 200, `HTTP ${posted}`);

  const echoedFromExtension = await d.eval(`
    fetch('http://127.0.0.1:${ECHO_PORT}/', { method: 'POST', body: '{}' })
      .then(r => r.json()).then(j => j.origin ?? '(none)')`);
  check('the extension sends no Origin', echoedFromExtension === '(none)',
    `sent ${JSON.stringify(echoedFromExtension)}`);

  /* The app does not take the strip on trust, because it cannot: the rule is
     registered by a background script the browser starts when it likes, and
     opening the side panel is not an occasion it starts one for. So the app
     asks, and this is the question and the answer — the one the 403 message
     and the CORS bypass screen are both written from. */
  const handshake = await d.eval(`
    (globalThis.browser ?? globalThis.chrome).runtime
      .sendMessage({ type: 'ivx:origin-strip' })
      .then(r => r?.stripped ?? '(no answer)')
      .catch(e => 'THREW: ' + e.message)`);
  check('the app can confirm the strip is in place', handshake === true,
    `answered ${JSON.stringify(handshake)}`);

  /* The control that makes the one above safe rather than merely effective.
     Stripping Origin browser-wide would take a real protection away from every
     site the person visits, so an ordinary page must be untouched. */
  const echoedFromPage = await d.evalOnPlainPage(`
    fetch('http://127.0.0.1:${ECHO_PORT}/', { method: 'POST', body: '{}' })
      .then(r => r.json()).then(j => j.origin ?? '(none)')`);
  check('an ordinary page keeps its Origin',
    echoedFromPage === `http://127.0.0.1:${CONTROL_PORT}`,
    `sent ${JSON.stringify(echoedFromPage)}`);

  /* The app's offline worker must not be here: it has nothing to cache that is
     not already on disk, and its "a new version is ready" prompt would be
     unanswerable, since an extension updates as an extension.

     What this cannot assert is that nothing controls the page, because
     something does — an MV3 background worker is registered at the extension
     root and claims every extension page — so both halves look for sw.js by
     name instead of counting registrations. */
  const sw = await d.eval(`
    (async () => {
      if (!navigator.serviceWorker) return { own: 0, controller: null };
      const regs = await navigator.serviceWorker.getRegistrations();
      const urls = regs.map(r => r.active?.scriptURL ?? r.installing?.scriptURL ?? '');
      return {
        own: urls.filter(u => u.endsWith('/sw.js')).length,
        controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      };
    })()`);
  check("the app's offline worker is not registered",
    sw.own === 0 && !String(sw.controller ?? '').endsWith('/sw.js'), JSON.stringify(sw));

  check('the PWA manifest link is gone',
    await d.eval('!document.querySelector("link[rel=manifest]")'));

  const raw = await d.consoleErrors();
  if (raw === null) {
    check('the console is clean', false, 'could not be read');
  } else {
    // The favicon is not part of the app and the browser asks for one anyway.
    const errors = raw.filter(t => !/favicon/i.test(t));
    check('the console is clean', errors.length === 0, errors.slice(0, 3).join(' | '));
  }
}

/* ── go ────────────────────────────────────────────────────── */

const DRIVERS = { chrome: chromeDriver, firefox: firefoxDriver };

const wanted = process.argv.slice(2).filter(a => !a.startsWith('--'));
for (const w of wanted) if (!DRIVERS[w]) { console.error(`extension-test: unknown browser "${w}"`); process.exit(1); }
const browsers = wanted.length ? wanted : Object.keys(DRIVERS);

let mock, control, echo;
const all = [];

async function main() {
  /* An endpoint that sends no CORS headers, and turns down anything carrying
     an Origin — both of the ways a local runtime refuses a browser. */
  await insistPortIsFree(MOCK_PORT, 'the mock provider');
  await insistPortIsFree(CONTROL_PORT, 'the control page');
  await insistPortIsFree(ECHO_PORT, 'the origin echo');

  mock = spawn('node', ['tools/mock-provider.mjs', '--no-cors', '--check-origin'],
    { cwd: join(root, 'web'), stdio: 'ignore' });
  if (!await waitFor(() => fetch(`http://127.0.0.1:${MOCK_PORT}/v1/models`).then(r => r.ok))) {
    throw new Error('the mock provider never came up');
  }

  // Somewhere for the control page to be served from: a second origin, local,
  // so the comparison does not depend on this machine having a network.
  control = createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>control</title>');
  }).listen(CONTROL_PORT);

  /* Says which Origin it was sent, and allows everyone, so the extension and
     an ordinary page can both be asked the same question and compared. */
  echo = createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify({ origin: req.headers.origin ?? null }));
  }).listen(ECHO_PORT);

  for (const name of browsers) {
    console.log(`\n── ${name} ────────────────────────────────`);
    const results = [];
    const check = (label, ok, detail = '') => {
      results.push({ label, ok });
      console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
    };
    let d = null;
    try {
      d = await DRIVERS[name]();
      console.log(`  ${d.label}\n`);
      await runChecks(d, check);
    } catch (err) {
      check(`${name} ran at all`, false, err.message);
    } finally {
      await d?.stop().catch(() => {});
    }
    all.push({ name, results });
  }
}

main()
  .catch(err => { console.error(`\nextension-test: ${err.message}`); all.push({ name: 'run', results: [{ ok: false }] }); })
  .finally(() => {
    mock?.kill();
    control?.close();
    echo?.close();
    console.log('');
    let failed = 0;
    for (const { name, results } of all) {
      const bad = results.filter(r => !r.ok).length;
      failed += bad;
      console.log(`${name}: ${results.length - bad}/${results.length} passed`);
    }
    process.exit(failed ? 1 : 0);
  });
