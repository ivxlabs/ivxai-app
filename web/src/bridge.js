// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The CORS bridge: an optional loopback daemon that forwards provider calls.

   A browser will not let this page talk to an endpoint that does not answer
   with CORS headers, and plenty of them do not — Ollama on its defaults, a
   bare llama.cpp build, a company proxy from 2016. That is a rule about the
   browser, not about the endpoint: the same machine can reach it perfectly
   well. So the bridge is a small program on that machine which does.

   It is off until you turn it on, and this module is all the app knows about
   it: where it is, whether it answered, and how to rewrite one URL to go
   through it. Requests still carry your key and still go to the endpoint you
   configured — one extra hop, over loopback, on your own computer.

   In the desktop and mobile app the same server runs inside the app process
   and announces itself on `window.__IVXAI_BRIDGE__`, so there is nothing to
   install and nothing to turn on. See github.com/ivxlabs/ivxai-app.

   For someone who cannot run a bridge at all — a phone, a work laptop, Safari
   — there is also the hosted one, the ivx/ai API at api.ivx.run/ai. It speaks
   the same /health and /proxy, behind a token of the person's own. It is a
   fallback and never the first choice: a call goes that way only when it is
   switched on and the bridge on this machine is off or not answering, and a
   call to an endpoint on this machine or network never goes that way at all,
   since a server on the internet could not reach it and has no business
   learning it is there. It is also, unlike the bridge here, somebody else's
   computer, and the settings screen says so. */

import { kvGet, kvSet } from './store.js';

/** Bumped when /proxy changes shape; /health reports what the daemon speaks. */
export const PROTOCOL = 1;

/**
 * Whether this page *is* a browser extension.
 *
 * An extension page runs on its own origin and carries the host permissions
 * declared in its manifest, so the browser lets it call any endpoint directly:
 * an Ollama on its defaults, a provider that refuses web origins, plain http
 * on loopback from a page that is not itself http.
 *
 * That settles CORS — the browser's rule — and not the other half. The request
 * still goes out as `Origin: chrome-extension://<id>`, and an endpoint that
 * vets that header answers 403 no matter what the browser permitted. The
 * extension drops the header for exactly this reason (see background.js), but
 * only while the background script has actually run, which is why
 * `stripsOrigin()` below is a question and not an assumption — and why a
 * bridge turned on here is used rather than ignored.
 *
 * Tested against the origin, not `chrome.runtime`, which a content script
 * injected into an ordinary page would also see. Only a page served from the
 * extension package itself gets those privileges.
 */
export const EXTENSION = /^(?:chrome|moz|safari-web)-extension:$/.test(location.protocol);

export const DEFAULT_URL = 'http://127.0.0.1:8787';

/* What the extension's background script said about the `Origin` header:
   true it is being dropped, false it is not, null nobody has asked yet. */
let originStrip = null;

const HANDSHAKE_MS = 3000;

/**
 * Ask the extension whether our `Origin` is being dropped.
 *
 * Worth asking rather than assuming, because the rule that drops it is
 * registered by a background script the browser starts only when it feels like
 * it — opening the side panel does not start one — and because a build loaded
 * before that rule existed keeps running until the extension is reloaded by
 * hand. In both cases every POST to an origin-checking endpoint fails with a
 * 403 that reads like a bad API key.
 *
 * Asking also fixes the first case: the message is an event, and the event is
 * what starts the script. So this is a repair as much as a check, and the
 * answer is what the 403 message and the CORS bypass screen are written from.
 *
 * Never throws, and never waits forever: no answer is the same fact as `false`
 * for everything downstream.
 */
export async function checkOriginStrip() {
  if (!EXTENSION) return null;
  const runtime = globalThis.browser?.runtime ?? globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    originStrip = false;
    return originStrip;
  }
  try {
    const answer = await Promise.race([
      runtime.sendMessage({ type: 'ivx:origin-strip' }),
      new Promise(resolve => setTimeout(() => resolve(null), HANDSHAKE_MS)),
    ]);
    originStrip = Boolean(answer?.stripped);
  } catch {
    // No receiver: the background script is gone, or it is an older build of
    // this extension that does not know the question.
    originStrip = false;
  }
  return originStrip;
}

/** The last answer to the above: true, false, or null if never asked. */
export const stripsOrigin = () => originStrip;

/* Both spellings of loopback: which one resolves, and how fast, differs
   between machines, and a daemon bound to 127.0.0.1 may not answer on ::1. */
const CANDIDATES = [DEFAULT_URL, 'http://localhost:8787'];

const KV_KEY = 'bridge';
const KV_HOSTED = 'bridgeHosted';

export const HOSTED_URL = 'https://api.ivx.run/ai';

const state = {
  enabled: false,
  url: '',
  token: '',
  builtIn: false,   // supplied by the desktop/mobile shell, not configurable
  health: null,     // last /health response, or null if it did not answer
  checkedAt: 0,
};

/* The hosted fallback. Its own switch, address and token, kept apart from the
   bridge above so turning one off never forgets how to reach the other. */
const hosted = {
  enabled: false,
  url: HOSTED_URL,
  token: '',
  health: null,
  checkedAt: 0,
};

const trimSlash = url => String(url || '').replace(/\/+$/, '');

/* A local bridge that stopped answering is looked for again this often, at
   most, so calls come back to it by themselves once it is running again. */
const RECHECK_MS = 60 * 1000;

/**
 * Whether a URL names this machine or its network.
 *
 * Those stay off the hosted bridge whatever else is true. It could not reach
 * them, and sending it `http://192.168.1.20:11434` would tell a server on the
 * internet about someone's home network for nothing.
 */
export function isPrivateUrl(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return true; }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.lan') || (!host.includes('.') && !host.includes(':'))) {
    return true;
  }
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127);
  }
  return host.includes(':') &&
    (host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:'));
}

/**
 * Ask a bridge what it is.
 *
 * /health answers every origin, including ones /proxy would refuse, and says
 * so in `originAllowed`. That is the difference between "nothing is listening"
 * and "something is listening but not for this page" — two problems with very
 * different fixes, which a bare CORS failure cannot tell apart.
 */
export async function probe(url, { timeoutMs = 2500, token = '' } = {}) {
  const base = trimSlash(url);
  if (!base) throw new Error('No address');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // A token is only sent to the hosted bridge, which answers with whether
    // it knows it (`tokenOk`). The one on this machine has no use for it here.
    const res = await fetch(`${base}/health`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      ...(token ? { headers: { 'X-Ivx-Token': token } } : {}),
    });
    if (!res.ok) throw new Error(`The bridge answered ${res.status}`);
    const json = await res.json();
    // Bridges before 0.3.0 called themselves ivx-bridge.
    if (json?.name !== 'ivxai-bridge' && json?.name !== 'ivx-bridge') {
      throw new Error('Something else is on that port');
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Try the usual addresses and return the first bridge that answers. */
export async function detect({ extra = [] } = {}) {
  const seen = new Set();
  const urls = [...extra, ...CANDIDATES].map(trimSlash).filter(u => u && !seen.has(u) && seen.add(u));
  for (const url of urls) {
    try {
      return { url, health: await probe(url, { timeoutMs: 1200 }) };
    } catch {
      /* nothing there — try the next spelling */
    }
  }
  return null;
}

/* ── configuration ─────────────────────────────────────────── */

/**
 * Read the saved setting, or adopt the one the app shell injected.
 *
 * Returns immediately; it does not wait on the network. Call `verify()` after
 * to find out whether the bridge is actually there.
 */
export async function init() {
  const injected = globalThis.__IVXAI_BRIDGE__;
  if (injected?.url) {
    Object.assign(state, {
      builtIn: true,
      enabled: true,
      url: trimSlash(injected.url),
      token: injected.token || '',
    });
    return status();
  }
  const saved = await kvGet(KV_KEY, null);
  if (saved?.url) {
    Object.assign(state, {
      enabled: Boolean(saved.enabled),
      url: trimSlash(saved.url),
      token: saved.token || '',
    });
  }
  const savedHosted = await kvGet(KV_HOSTED, null);
  if (savedHosted) {
    Object.assign(hosted, {
      enabled: Boolean(savedHosted.enabled),
      url: trimSlash(savedHosted.url) || HOSTED_URL,
      token: savedHosted.token || '',
    });
  }
  return status();
}

const persist = () => kvSet(KV_KEY, {
  enabled: state.enabled,
  url: state.url,
  token: state.token,
});

const persistHosted = () => kvSet(KV_HOSTED, {
  enabled: hosted.enabled,
  url: hosted.url,
  token: hosted.token,
});

/**
 * Save where the bridge is without requiring it to be there yet.
 *
 * Separate from `enable` so the address and token can be set up before the
 * daemon is started — `enable` has to fail loudly when nothing answers, which
 * would otherwise make an address you cannot yet reach impossible to type.
 */
export async function configure({ url, token } = {}) {
  if (url !== undefined) state.url = trimSlash(url);
  if (token !== undefined) state.token = token;
  if (!state.builtIn) await persist();
  return state.enabled ? verify() : status();
}

/** Point at a bridge and turn it on. Throws if it does not answer. */
export async function enable({ url = DEFAULT_URL, token = '' } = {}) {
  const health = await probe(url);
  Object.assign(state, {
    enabled: true,
    url: trimSlash(url),
    token,
    health,
    checkedAt: Date.now(),
  });
  if (!state.builtIn) await persist();
  return status();
}

export async function disable() {
  state.enabled = false;
  state.health = null;
  if (!state.builtIn) await persist();
  return status();
}

/* ── the hosted fallback ───────────────────────────────────── */

/** Save the hosted bridge's address or token, without needing it to answer. */
export async function configureHosted({ url, token } = {}) {
  if (url !== undefined) hosted.url = trimSlash(url) || HOSTED_URL;
  if (token !== undefined) hosted.token = token;
  await persistHosted();
  return hosted.enabled ? verifyHosted() : status();
}

/**
 * Turn the hosted fallback on. Throws, with a sentence worth showing, unless
 * it answers, accepts this page, and knows the token.
 */
export async function enableHosted({ url = hosted.url, token = hosted.token } = {}) {
  if (!token) throw new Error('The hosted bridge needs your ivx/ai token first');
  const health = await probe(url, { token });
  if (!health.originAllowed) throw new Error(`${trimSlash(url)} does not accept ${location.origin}`);
  if (health.tokenOk === false) throw new Error('The hosted bridge does not recognise that token');
  Object.assign(hosted, { enabled: true, url: trimSlash(url), token, health, checkedAt: Date.now() });
  await persistHosted();
  return status();
}

export async function disableHosted() {
  hosted.enabled = false;
  hosted.health = null;
  await persistHosted();
  return status();
}

async function verifyHosted() {
  if (!hosted.enabled || !hosted.url || !hosted.token) return status();
  try {
    hosted.health = await probe(hosted.url, { token: hosted.token });
  } catch {
    hosted.health = null;
  }
  hosted.checkedAt = Date.now();
  return status();
}

/** On, answering, willing to serve this page, and not refusing the token. */
function hostedReady() {
  if (state.builtIn) return false;
  const h = hosted.health;
  return Boolean(hosted.enabled && hosted.token && h?.ok && h.originAllowed && h.tokenOk !== false);
}

/** Re-check both bridges we know about. Never throws. */
export async function verify() {
  const local = (async () => {
    if (!state.enabled || !state.url) return;
    try {
      state.health = await probe(state.url);
    } catch {
      state.health = null;
    }
    state.checkedAt = Date.now();
  })();
  await Promise.all([local, verifyHosted()]);
  return status();
}

/* ── using it ──────────────────────────────────────────────── */

/**
 * On, reachable, and willing to serve this origin.
 *
 * A built-in bridge skips the check. The app started that server itself, so
 * waiting for a probe to come back would send every call made in the first
 * moments straight at the provider — which is the one thing that cannot work
 * in a webview. If it really is broken, a bridge error says so; silently
 * falling back to a route we know is blocked would not.
 */
export function ready() {
  if (state.builtIn) return true;
  return Boolean(state.enabled && state.health?.ok && state.health.originAllowed);
}

/**
 * Can this page reach an endpoint that does not answer browser origins?
 *
 * `ready()` asks whether the bridge is up; this asks the question the UI and
 * the local-server scan actually care about, which the extension build answers
 * yes to without any bridge at all.
 */
export function unrestricted() {
  // An extension reaches a CORS-less endpoint by itself, but one that turns
  // requests away on their `Origin` is only reachable while the header is
  // being dropped. Unasked (null) is taken as yes: it is the answer in every
  // working install, and the check that would say otherwise runs at boot.
  if (EXTENSION && originStrip !== false) return true;
  return ready() || hostedReady();
}

/**
 * Which bridge a call to `url` would go through: 'local', 'hosted', or null
 * for straight from this page.
 *
 * The bridge on this machine whenever it is up. The hosted one only in its
 * place, only for endpoints on the internet, and never for itself — calls to
 * the ivx/ai API as a provider go to it directly, as it answers browsers.
 */
export function via(url, { hosted: allowHosted = true } = {}) {
  if (ready()) return 'local';
  // Down, or never looked for: look again in the background, so the calls
  // after this one come back to it by themselves once it is running.
  if (state.enabled && !state.builtIn && Date.now() - state.checkedAt > RECHECK_MS) {
    state.checkedAt = Date.now();
    probe(state.url).then(h => { state.health = h; }, () => { state.health = null; });
  }
  if (!allowHosted || !hostedReady()) return null;
  if (isPrivateUrl(url) || String(url).startsWith(`${hosted.url}/`)) return null;
  return 'hosted';
}

export function status() {
  return {
    ...state,
    ready: ready(),
    reachable: Boolean(state.health?.ok),
    hosted: {
      ...hosted,
      ready: hostedReady(),
      reachable: Boolean(hosted.health?.ok),
      tokenRefused: hosted.health?.tokenOk === false,
    },
    // A bridge from a different era of the app. Better to say so than to send
    // it requests it will not understand.
    outdated: Boolean(state.health && state.health.protocol !== PROTOCOL),
  };
}

/**
 * Rewrite one request to travel via a bridge — the one on this machine, or
 * the hosted one in its place (see `via`).
 *
 * Returns `[url, headers]` unchanged when neither is in use, so every call
 * site is a single line and there is no second code path to keep in step.
 * The token goes in a header rather than the query string to keep it out of
 * anything that records URLs. `{ hosted: false }` keeps a call off the hosted
 * bridge, for the rare one that should never leave this browser by that way.
 */
export function apply(url, headers = {}, options = {}) {
  // No special case for the extension. It does reach most endpoints directly,
  // which is why the bridge is off there by default — but someone who turned
  // it on did so to get past an endpoint that turned them away, and quietly
  // sending the call direct anyway would leave the switch doing nothing.
  const route = via(url, options);
  if (!route) return [url, headers];
  const { url: base, token } = route === 'local' ? state : hosted;
  return [`${base}/proxy?url=${encodeURIComponent(url)}`, token ? { ...headers, 'X-Ivx-Token': token } : headers];
}

/**
 * The bridge's own route — e.g. `/mcp/stdio` — not a proxied endpoint.
 *
 * Returns `[null, headers]` when no bridge is configured, so the caller can
 * explain why rather than fail with a bare network error. Same gating as
 * `apply`: on only, and reachable unless the app started it itself.
 */
export function self(path, headers = {}) {
  if (!ready()) return [null, headers];
  const via = `${state.url}${path}`;
  return [via, state.token ? { ...headers, 'X-Ivx-Token': state.token } : headers];
}

/**
 * Whether this bridge can run local MCP servers (`/mcp/stdio`).
 *
 * A built-in bridge ships inside the app, so it is whatever the app speaks;
 * a bridge someone installed separately has to say so in /health, which also
 * keeps an old daemon from being sent requests it would only refuse.
 */
export function supportsMcp() {
  if (state.builtIn) return true;
  return Boolean(state.health?.mcp);
}

/**
 * Why a call that went through the bridge never came back.
 *
 * A thrown fetch on the bridge path is not a fact about the provider: the
 * browser never contacted the provider, the bridge was going to. Blaming the
 * endpoint in that case sends people to restart a server that was never asked
 * anything. So this re-probes — /health answers every origin, including ones
 * /proxy refuses — and reports which hop actually broke.
 *
 * Never throws; it is called from an error path.
 */
export async function explainUnreachable(route = 'local') {
  if (route === 'hosted') {
    await verify();
    // The bridge here came back while that call was out: the next one uses it.
    if (ready()) return 'The call went through the hosted bridge, and was cut off. The bridge on this machine is answering again, so try once more.';
    if (hostedReady()) {
      return `The request through the hosted bridge at ${hosted.url} was cut off, though it is ` +
        'answering now. Worth trying again.';
    }
    if (hosted.health?.tokenOk === false) {
      return `The hosted bridge at ${hosted.url} no longer recognises your token. ` +
        'Settings → CORS bypass → Hosted bridge.';
    }
    return `The hosted bridge at ${hosted.url} did not answer. Is this device online?`;
  }

  const where = state.builtIn ? 'the bridge built into this app' : `the bridge at ${state.url}`;
  const Where = where[0].toUpperCase() + where.slice(1);
  await verify();
  // Gone from here, but the hosted one can stand in: say that the next try
  // will not fail the same way, rather than send someone to restart a daemon.
  const fallback = hostedReady()
    ? ` Until it is back, calls to online services go through the hosted bridge at ${hosted.url} — try again.`
    : '';

  if (state.health?.ok) {
    if (!state.health.originAllowed) {
      return `${Where} is running, but it does not accept requests from ${location.origin}. ` +
        `Restart it with --allow-origin ${location.origin}.`;
    }
    // It answered a moment later, so it is up and willing: the request itself
    // was cut off rather than refused.
    return `The request through ${where} was cut off, though it is running and ` +
      'answering now. It may have been restarted mid-request, or the endpoint ' +
      'behind it closed the connection. Worth trying again.';
  }

  if (location.protocol === 'https:' && state.url.startsWith('http:')) {
    return `${Where} did not answer. Either it is not running, or this browser is ` +
      'refusing to let an HTTPS page reach a plain-HTTP address on this machine — ' +
      'Safari does that, where Chrome and Firefox do not. The desktop app carries ' +
      'its own bridge; a standalone one can serve the app itself with --ui-dir, ' +
      'which puts both on the same origin.' + fallback;
  }
  return `${Where} did not answer. Is it still running?${fallback}`;
}

/** One line for a settings row. */
export function describe() {
  if (EXTENSION) {
    if (state.enabled && state.health?.ok) return `On — provider calls go via ${state.url}`;
    if (state.enabled) return `Not answering at ${state.url}`;
    return originStrip === false
      ? 'Off — and this extension is sending an Origin some endpoints refuse'
      : 'Off — the extension calls endpoints directly';
  }
  if (state.builtIn) return state.health ? 'Built into this app' : 'Built in, but not answering';
  const host = (() => { try { return new URL(hosted.url).host; } catch { return hosted.url; } })();
  if (!ready() && hostedReady()) {
    return state.enabled
      ? `Via ${host} — the bridge here is not answering`
      : `Via ${host} for online services`;
  }
  if (!state.enabled) return 'Off — the browser talks to providers directly';
  if (!state.health) return `Not answering at ${state.url}`;
  if (!state.health.originAllowed) return 'Running, but not accepting this origin';
  if (status().outdated) return `Running, but speaks protocol ${state.health.protocol}`;
  return `On — via ${state.url}`;
}
