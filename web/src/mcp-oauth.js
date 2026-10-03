// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Signing in to an MCP server.

   Plenty of hosted MCP servers — Notion, Linear, Sentry — are given to a
   client as nothing but a URL and the sentence "complete the OAuth flow when
   prompted". There is no token to paste and no page that will show you one:
   the client is expected to discover where to authorize, register itself,
   send you to sign in, and come back with a token. That is what this does.

   It is OAuth 2.1 as the MCP specification profiles it, which is four RFCs
   standing in a trench coat:

     RFC 9728  the 401 names its own metadata document, which names the
               authorization server. No guessing where to sign in.
     RFC 8414  that server publishes where to authorize, where to swap a code
               for a token, and where to register.
     RFC 7591  we register ourselves, at the moment someone first connects.
               There is no developer account behind this app to pre-register
               with, and there could not be: every install is its own client.
     RFC 7636  PKCE, because a public client has no secret worth having.

   Plus RFC 8707's `resource` parameter, which is what stops a token minted
   for one MCP server being spendable at another.

   ── no backend, still

   Every step is a fetch from this browser and a window the person can see. No
   part of this passes through a server of ours, because there isn't one: the
   client id is registered from here, the code comes back to here, and the
   tokens are kept in the same vault as the API keys — encrypted at rest as
   soon as a passphrase is set, and never sent anywhere but the server they
   belong to.

   ── where the code comes back to

   The one thing a browser makes hard. An authorization server will only
   redirect to an address it was given at registration, and it will not accept
   `chrome-extension://`. Two answers, picked by what the build has:

     the extension   `identity.launchWebAuthFlow`, which hands out an https
                     address on the browser's own domain and intercepts the
                     redirect to it. The permission is optional and asked for
                     on the click that needs it — see `redirectUri`.
     everywhere else a popup to oauth.html on this app's own origin, which
                     posts the code back to the window that opened it. */

import * as vault from './vault.js';
import * as bridge from './bridge.js';

/** What a registration calls us, and what a server shows the person on the
    consent screen. */
const CLIENT_NAME = 'ivx/ai Chat';

/** A whole sign-in, from the click to the token. Generous: it contains a
    person reading a consent screen, and possibly logging in first. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

/** One discovery or token request. */
const HTTP_TIMEOUT_MS = 30 * 1000;

/** Refreshed this long before the server would call it expired, so a token
    does not go stale between the check and the call that uses it. */
const REFRESH_MARGIN_MS = 60 * 1000;

const identity = () => globalThis.browser?.identity ?? globalThis.chrome?.identity ?? null;
const permissions = () => globalThis.browser?.permissions ?? globalThis.chrome?.permissions ?? null;

/** Thrown when a server wants a sign-in that has not happened. Carries the
    challenge so the flow does not have to go looking for it again. */
export class NeedsAuth extends Error {
  constructor(challenge = '', message = 'This server needs you to sign in.', detail = '') {
    super(message);
    this.name = 'NeedsAuth';
    this.challenge = challenge;
    // What the server itself said, kept apart from our sentence about it so a
    // status line can show one and a toast the other.
    this.detail = detail;
  }
}

/* ── the tokens ────────────────────────────────────────────── */

/* In the vault, under a key that cannot collide with a provider's: provider
   ids are opaque, this one is prefixed. A refresh token is a standing
   credential — it outlives the session and can mint new access tokens — so it
   belongs behind the passphrase with everything else of that kind, not in the
   server record beside the URL. */
const vaultKey = serverId => `mcp-oauth:${serverId}`;

/** What is stored for a server, or null. Also null while the vault is locked,
    which reads downstream as "not signed in" — the same prompt either way. */
export function tokensFor(serverId) {
  try {
    return JSON.parse(vault.getKey(vaultKey(serverId)) || 'null');
  } catch {
    return null;
  }
}

async function keepTokens(serverId, tokens) {
  await vault.setKey(vaultKey(serverId), JSON.stringify(tokens));
}

/** Forget a sign-in. The server's own session is not ours to end, so this
    says what it does: this browser stops holding the token. */
export async function signOut(serverId) {
  await vault.removeKey(vaultKey(serverId));
}

/** Whether this server has been signed in to. */
export const connected = serverId => Boolean(tokensFor(serverId)?.accessToken);

/* ── fetching, the way the rest of the app fetches ─────────── */

/**
 * One request to an authorization server.
 *
 * Routed through the bridge when the MCP server it belongs to is, because an
 * authorization server that refuses browser origins refuses them for
 * discovery exactly as it does for JSON-RPC, and a person who has already
 * turned the bridge on for a server should not have to discover that twice.
 */
async function ask(url, init, server) {
  const headers = { Accept: 'application/json', ...(init?.headers || {}) };
  const [endpoint, finalHeaders] = server?.viaBridge
    ? bridge.apply(url, headers)
    : [url, headers];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(endpoint, { ...init, headers: finalHeaders, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A JSON document, or null when it is not there. Only a 200 with JSON counts
    — a discovery URL that does not exist answers with anything at all, and an
    HTML 404 page is not metadata. */
async function askJson(url, server, init) {
  let res;
  try {
    res = await ask(url, init, server);
  } catch {
    return null;
  }
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/* ── discovery ─────────────────────────────────────────────── */

/** The `resource_metadata` a 401's WWW-Authenticate points at, if it has one. */
function metadataUrlFrom(challenge) {
  const hit = /resource_metadata\s*=\s*"([^"]+)"/i.exec(String(challenge || ''));
  return hit?.[1] || null;
}

/**
 * The well-known URLs to try for a document, in the order the RFCs say.
 *
 * A server at `https://host/mcp` publishes at
 * `https://host/.well-known/<doc>/mcp` — the path goes *after* the well-known
 * segment, which reads wrong and is what RFC 8414 says, so that both a root
 * server and one under a path can be found on the same host. The bare form is
 * tried after it, because plenty of servers only publish that one.
 */
function wellKnown(base, doc) {
  const url = new URL(base);
  const path = url.pathname.replace(/\/+$/, '');
  const out = [];
  if (path && path !== '/') out.push(`${url.origin}/.well-known/${doc}${path}`);
  out.push(`${url.origin}/.well-known/${doc}`);
  return out;
}

/**
 * Which authorization server stands in front of this MCP server, and what it
 * says about itself.
 *
 * The 401 is the good path: it names its metadata document outright, and that
 * document names the authorization server. Everything after is for servers
 * written against an earlier draft — the well-known lookups, and finally the
 * assumption that the MCP server is its own authorization server, which is
 * what the first revision of this spec said.
 */
export async function discover(server, challenge = '') {
  const url = String(server.url || '').trim();
  if (!url) throw new Error('This server has no URL to sign in to.');

  const candidates = [metadataUrlFrom(challenge), ...wellKnown(url, 'oauth-protected-resource')]
    .filter(Boolean);

  let resource = null;
  for (const candidate of candidates) {
    resource = await askJson(candidate, server);
    if (resource) break;
  }

  const issuers = resource?.authorization_servers?.length
    ? resource.authorization_servers
    : [new URL(url).origin];

  for (const issuer of issuers) {
    for (const doc of ['oauth-authorization-server', 'openid-configuration']) {
      for (const candidate of wellKnown(issuer, doc)) {
        const metadata = await askJson(candidate, server);
        if (metadata?.authorization_endpoint && metadata?.token_endpoint) {
          return {
            issuer: metadata.issuer || issuer,
            metadata,
            // What the token is *for*, which is the MCP server and not the
            // authorization server. RFC 8707 calls this the resource; the MCP
            // spec requires it, and it is the difference between a token that
            // works only here and a bearer token good anywhere that issuer is
            // trusted.
            resourceId: resource?.resource || canonical(url),
            scopes: resource?.scopes_supported || metadata.scopes_supported || [],
          };
        }
      }
    }
  }

  throw new Error(
    'Could not find out where to sign in — this server publishes no OAuth ' +
    'metadata. If it issues tokens by hand, paste one in the field below instead.',
  );
}

/** The MCP server's own identifier, as RFC 8707 wants it: no fragment, and no
    trailing slash to disagree with the server about. */
function canonical(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.href.replace(/\/$/, '');
}

/* ── registration ──────────────────────────────────────────── */

/**
 * Become a client of this authorization server.
 *
 * There is no developer account behind this app and there should not be: a
 * client id issued to "ivx/ai Chat" centrally would be a credential every
 * install shared, and a way for us to be in the middle of a thing we have gone
 * to some length not to be in the middle of. So each install registers itself,
 * once per server, the first time someone connects.
 *
 * `token_endpoint_auth_method: none` is the honest declaration: this is a
 * public client, its secret would be sitting in a browser, and PKCE is what
 * stands in for one.
 */
async function register(found, redirectUri, server) {
  const endpoint = found.metadata.registration_endpoint;
  if (!endpoint) {
    throw new Error(
      'This server does not let clients register themselves, so it cannot be ' +
      'connected automatically. If it issued you a token, paste it in the ' +
      'field below instead.',
    );
  }
  const res = await ask(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(found.scopes.length ? { scope: found.scopes.join(' ') } : {}),
    }),
  }, server);

  if (!res.ok) {
    throw new Error(`Registering with ${found.issuer} failed: ${await why(res)}`);
  }
  const body = await res.json();
  if (!body?.client_id) throw new Error('The server registered us without giving us a client id.');
  return { clientId: body.client_id, clientSecret: body.client_secret || '' };
}

/** What went wrong, in the server's own words where it gave any. */
async function why(res) {
  try {
    const text = await res.text();
    const json = JSON.parse(text);
    return json.error_description || json.error || text.slice(0, 200) || `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/* ── PKCE ──────────────────────────────────────────────────── */

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

async function pkce() {
  const verifier = randomString();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

/* ── the window the person actually uses ───────────────────── */

/**
 * Where the authorization server should send the browser back to.
 *
 * In the extension this is the browser's own redirect address, which needs the
 * `identity` permission — optional in the manifest, and asked for here, on the
 * click that needs it, so an install that never connects an OAuth server is
 * never asked at all. Everywhere else it is a page of this app's own.
 */
export async function redirectUri() {
  // Decided by which build this is, not by whether `identity` happens to be
  // visible: the permission is optional, and a browser may hide the namespace
  // entirely until it is granted — so checking for the API first would fall
  // through to a `moz-extension://` redirect that no server will accept.
  if (!bridge.EXTENSION) return new URL('oauth.html', location.href).href;

  /* Asked for outright rather than checked first. `request` needs the user
     gesture of the click that got here and an `await` before it loses one, so
     the check that looks like it would save a prompt only costs the gesture —
     host-access.js makes the same bargain for the same reason.

     The answer is not read. A permission already held resolves true; one the
     browser requires rather than offers as optional — `identity` on Firefox —
     rejects, and is already held anyway. What actually settles it is whether
     the API is there afterwards, and then whether the flow runs, which fails
     loudly on its own. Guessing at three browsers' rules for optional
     permissions would be guessing. */
  await permissions()?.request({ permissions: ['identity'] }).catch(() => {});

  const api = identity();
  if (!api?.getRedirectURL) {
    throw new Error(
      'This browser does not give extensions a way to complete a sign-in. ' +
      'Connect this server in the app at ai.ivx.run instead, or paste a token ' +
      'if the server issues them.',
    );
  }
  return api.getRedirectURL();
}

/** Open the sign-in window and come back with what the server redirected to. */
async function collectCode(authUrl, redirect, expectedState) {
  const api = identity();
  if (bridge.EXTENSION) {
    if (!api?.launchWebAuthFlow) {
      throw new Error('This browser does not offer extensions a way to complete a sign-in.');
    }
    const landed = await api.launchWebAuthFlow({ url: authUrl, interactive: true });
    if (!landed) throw new Error('The sign-in window closed without finishing.');
    return readCode(new URL(landed), expectedState);
  }

  const popup = window.open(authUrl, 'ivx-mcp-oauth', 'width=520,height=720,noopener=no');
  if (!popup) throw new Error('The sign-in window was blocked. Allow popups for this page and try again.');

  return new Promise((resolve, reject) => {
    const done = outcome => {
      clearInterval(watch);
      clearTimeout(expiry);
      window.removeEventListener('message', onMessage);
      try { popup.close(); } catch { /* already gone */ }
      outcome();
    };
    const onMessage = ev => {
      // Only our own oauth.html, and only the message it sends. Anything else
      // on this channel is some other page talking to us.
      if (ev.origin !== location.origin || ev.data?.type !== 'ivx:oauth') return;
      done(() => {
        try {
          resolve(readCode(new URL(`?${new URLSearchParams(ev.data.params)}`, location.href), expectedState));
        } catch (err) {
          reject(err);
        }
      });
    };
    window.addEventListener('message', onMessage);
    const watch = setInterval(() => {
      if (popup.closed) done(() => reject(new Error('The sign-in window was closed before it finished.')));
    }, 500);
    const expiry = setTimeout(
      () => done(() => reject(new Error('The sign-in was not completed in time.'))),
      FLOW_TIMEOUT_MS,
    );
  });
}

/** The code out of a redirect, once it has been checked that this redirect is
    the one we sent. */
function readCode(url, expectedState) {
  // Some servers answer in the fragment; most in the query. Either way the
  // parameters are the same ones.
  const params = new URLSearchParams(url.search || '');
  for (const [k, v] of new URLSearchParams(url.hash.replace(/^#/, ''))) {
    if (!params.has(k)) params.set(k, v);
  }
  if (params.get('error')) {
    throw new Error(params.get('error_description') || params.get('error'));
  }
  /* The state check is the whole defence against someone else's code being
     planted in our redirect. It is compared before the code is used for
     anything, and a mismatch is not a retryable condition. */
  if (params.get('state') !== expectedState) {
    throw new Error('The sign-in came back with the wrong state and was not accepted.');
  }
  const code = params.get('code');
  if (!code) throw new Error('The sign-in came back without an authorization code.');
  return code;
}

/* ── swapping a code, and keeping it fresh ─────────────────── */

async function postToken(found, client, body, server) {
  const form = new URLSearchParams({ client_id: client.clientId, ...body });
  // A secret only if the server insisted on issuing one. A public client is
  // what we registered as, so usually there is none.
  if (client.clientSecret) form.set('client_secret', client.clientSecret);

  const res = await ask(found.metadata.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  }, server);

  if (!res.ok) throw new Error(await why(res));
  const json = await res.json();
  if (!json?.access_token) throw new Error('The server answered without an access token.');
  return {
    accessToken: json.access_token,
    // A server that rotates refresh tokens sends a new one; one that does not
    // sends none, and the old one stays good.
    refreshToken: json.refresh_token || body.refresh_token || '',
    expiresAt: json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0,
    tokenType: json.token_type || 'Bearer',
  };
}

/**
 * The whole sign-in, from a click to a stored token.
 *
 * Must be called straight out of that click: both the permission request and
 * the popup need the gesture, and an await before either loses it.
 */
export async function connect(server, challenge = '', { fresh = false } = {}) {
  /* Checked first, because the alternative is finding out after the person has
     read a consent screen and approved it: a locked vault cannot be written
     to, so the token would arrive with nowhere to go. */
  const { encrypted, unlocked } = vault.status();
  if (encrypted && !unlocked) {
    throw new Error('Unlock your keys first — Settings → Privacy & data — so the sign-in can be saved.');
  }
  const redirect = await redirectUri();
  const found = await discover(server, challenge);

  /* Registration is per server and kept, because re-registering on every
     sign-in would litter someone's account with a new "connected app" each
     time. It lives in the server record rather than the vault: a client id is
     a public identifier, and keeping it out of the vault means a locked vault
     still knows who we are.

     `fresh` is for the one case where keeping it is wrong. A server that
     rejected our token may have forgotten the client along with it — revoked
     from the other side, or simply gone — and a registration the server no
     longer honours cannot be detected from here: the authorize step answers
     `invalid_client` by *rendering a page*, which it must, because redirecting
     an error to a client it cannot vouch for is how you build an open
     redirector. From this side that is indistinguishable from someone taking a
     long time to read a consent screen, so the flow sits there until it times
     out. So the button that exists because something was already wrong starts
     over from registration rather than betting on the saved one. */
  const reusable = !fresh && server.oauth?.clientId && server.oauth?.issuer === found.issuer;
  const client = reusable
    ? { clientId: server.oauth.clientId, clientSecret: server.oauth.clientSecret || '' }
    : await register(found, redirect, server);

  const { verifier, challenge: codeChallenge } = await pkce();
  const state = randomString();

  const authUrl = new URL(found.metadata.authorization_endpoint);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', client.clientId);
  authUrl.searchParams.set('redirect_uri', redirect);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('resource', found.resourceId);
  if (found.scopes.length) authUrl.searchParams.set('scope', found.scopes.join(' '));

  const code = await collectCode(authUrl.href, redirect, state);

  const tokens = await postToken(found, client, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirect,
    code_verifier: verifier,
    resource: found.resourceId,
  }, server);

  await keepTokens(server.id, tokens);
  // Handed back rather than saved here: what belongs in the server record is
  // the caller's to persist, and mcp.js owns that file.
  return {
    oauth: {
      issuer: found.issuer,
      clientId: client.clientId,
      ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
      tokenEndpoint: found.metadata.token_endpoint,
      resourceId: found.resourceId,
      connectedAt: Date.now(),
    },
  };
}

/**
 * The Authorization header value to use now, refreshing first if the token is
 * about to expire. Empty when this server has no sign-in, which is the
 * ordinary case and not an error.
 */
export async function authHeader(server) {
  const tokens = tokensFor(server.id);
  if (!tokens?.accessToken) return '';
  if (!tokens.expiresAt || Date.now() < tokens.expiresAt - REFRESH_MARGIN_MS) {
    return `${tokens.tokenType || 'Bearer'} ${tokens.accessToken}`;
  }
  const renewed = await refresh(server);
  return renewed ? `${renewed.tokenType || 'Bearer'} ${renewed.accessToken}` : '';
}

/* One refresh in flight per server, shared by everyone who asks while it
   runs. Without this, two calls that notice the same expiring token both post
   the same refresh token — and a server that rotates them (which is the
   careful thing to do, and what Notion and the mock both do) honours the first
   and invalidates the second. The loser then stores a token that was dead on
   arrival, which presents as "signed in a moment ago, rejected now".

   A chat makes exactly the concurrent calls that trigger it: the prompt asks
   every server for its tools at once. */
const refreshing = new Map();   // server id -> Promise<tokens | null>

export function refresh(server) {
  const running = refreshing.get(server.id);
  if (running) return running;
  const started = refreshOnce(server).finally(() => refreshing.delete(server.id));
  refreshing.set(server.id, started);
  return started;
}

/**
 * Trade the refresh token for a new access token.
 *
 * Returns null rather than throwing when it cannot: every caller's next move
 * is the same either way — ask the person to sign in again — and a refresh
 * token that has been revoked is an ordinary end to a session, not a fault.
 */
async function refreshOnce(server) {
  const tokens = tokensFor(server.id);
  const oauth = server.oauth;
  if (!tokens?.refreshToken || !oauth?.tokenEndpoint || !oauth?.clientId) return null;
  try {
    const renewed = await postToken(
      { metadata: { token_endpoint: oauth.tokenEndpoint } },
      { clientId: oauth.clientId, clientSecret: oauth.clientSecret || '' },
      {
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        ...(oauth.resourceId ? { resource: oauth.resourceId } : {}),
      },
      server,
    );
    await keepTokens(server.id, renewed);
    return renewed;
  } catch {
    return null;
  }
}
