#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// An MCP server that makes you sign in, so the sign-in can be tested without
// an account anywhere.
//
//   node tools/mock-mcp-oauth.mjs [port]        default 8128
//
// It is the whole shape a hosted server presents, and nothing else: a 401 that
// names its metadata, the two discovery documents, dynamic registration, an
// authorize page that approves without asking, a token endpoint that checks
// PKCE, and one tool behind the bearer token.
//
// The parts worth having a mock for are the ones a real server will not let
// you get wrong twice: PKCE is verified rather than waved through, the
// redirect must match the one registered, a code is single-use, and the access
// token expires in ten seconds so a refresh happens while you watch.
//
// Add it to the app as a remote MCP server at http://127.0.0.1:8128/mcp and
// press Sign in.

import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const port = Number(process.argv[2]) || 8128;
const base = `http://127.0.0.1:${port}`;

const clients = new Map();   // client_id -> { redirectUris }
const codes = new Map();     // code -> { clientId, challenge, redirectUri, resource }
const tokens = new Map();    // access token -> { clientId, expiresAt }
const refreshes = new Map(); // refresh token -> clientId

/** Ten seconds, so the refresh path is exercised by any session worth the name. */
const TOKEN_TTL_S = 10;

const b64url = buf => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const json = (res, status, body, extra = {}) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    ...cors(),
    ...extra,
  });
  res.end(JSON.stringify(body));
};

/* Everything a browser client needs to read any of this at all. A real server
   that forgets these is indistinguishable, from the browser, from one that is
   down — which is the failure this mock exists to not have. */
const cors = () => ({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id, WWW-Authenticate',
});

const body = req => new Promise(resolve => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => resolve(text));
});

/** The bearer this request carries, if it is one we issued and still good. */
function bearer(req) {
  const header = req.headers.authorization || '';
  const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
  if (!token) return null;
  const held = tokens.get(token);
  if (!held || held.expiresAt < Date.now()) return null;
  return held;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, base);
  const path = url.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, cors()); res.end(); return; }

  /* ── discovery ───────────────────────────────────────────── */

  // The path form RFC 8414 asks for, and the bare one, because a client may
  // try either and both are this server.
  if (path === '/.well-known/oauth-protected-resource/mcp' ||
      path === '/.well-known/oauth-protected-resource') {
    return json(res, 200, {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: ['tools'],
      bearer_methods_supported: ['header'],
      resource_name: 'Mock MCP',
    });
  }

  if (path === '/.well-known/oauth-authorization-server' ||
      path === '/.well-known/openid-configuration') {
    return json(res, 200, {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ['tools'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    });
  }

  /* ── registration ────────────────────────────────────────── */

  if (path === '/register' && req.method === 'POST') {
    const reg = JSON.parse((await body(req)) || '{}');
    const redirectUris = reg.redirect_uris || [];
    if (!redirectUris.length) {
      return json(res, 400, { error: 'invalid_redirect_uri' });
    }
    const clientId = `mock-${randomUUID()}`;
    clients.set(clientId, { redirectUris });
    console.log(`register: ${clientId} -> ${redirectUris.join(', ')}`);
    return json(res, 201, {
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  }

  /* ── authorize ───────────────────────────────────────────── */

  // No consent screen: there is no account here to consent with, and what is
  // under test is the client's half. Everything a real server would reject is
  // still rejected.
  if (path === '/authorize') {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const challenge = url.searchParams.get('code_challenge');
    const client = clients.get(clientId);

    /* Rejections are rendered, not redirected, and that is not laziness: an
       authorization server must not bounce an error to a redirect_uri it
       cannot vouch for, or it is an open redirector. It is also why a client
       with a stale registration sees the flow hang rather than fail — the
       logging here is so that is visible from the terminal when it happens. */
    if (!client) {
      console.log(`authorize: REJECTED unknown client ${clientId}`);
      return json(res, 400, { error: 'invalid_client' });
    }
    if (!client.redirectUris.includes(redirectUri)) {
      console.log(`authorize: REJECTED redirect ${redirectUri}`);
      return json(res, 400, { error: 'invalid_redirect_uri', got: redirectUri });
    }
    if (url.searchParams.get('code_challenge_method') !== 'S256' || !challenge) {
      return json(res, 400, { error: 'invalid_request', detail: 'S256 PKCE required' });
    }

    const code = randomUUID();
    codes.set(code, {
      clientId, challenge, redirectUri,
      resource: url.searchParams.get('resource') || '',
    });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    if (state) back.searchParams.set('state', state);
    console.log(`authorize: ${clientId} -> ${back.href}`);
    res.writeHead(302, { Location: back.href, ...cors() });
    return res.end();
  }

  /* ── token ───────────────────────────────────────────────── */

  if (path === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await body(req));
    const grant = form.get('grant_type');

    const issue = clientId => {
      const access = b64url(Buffer.from(randomUUID() + randomUUID()));
      const refresh = b64url(Buffer.from(randomUUID() + randomUUID()));
      tokens.set(access, { clientId, expiresAt: Date.now() + TOKEN_TTL_S * 1000 });
      refreshes.set(refresh, clientId);
      return json(res, 200, {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: TOKEN_TTL_S,
        scope: 'tools',
      });
    };

    if (grant === 'refresh_token') {
      const clientId = refreshes.get(form.get('refresh_token'));
      if (!clientId) return json(res, 400, { error: 'invalid_grant' });
      // Rotated, the way a careful server does it, so a client that keeps the
      // old one is caught here rather than in production.
      refreshes.delete(form.get('refresh_token'));
      console.log('token: refreshed');
      return issue(clientId);
    }

    if (grant !== 'authorization_code') return json(res, 400, { error: 'unsupported_grant_type' });

    const entry = codes.get(form.get('code'));
    if (!entry) return json(res, 400, { error: 'invalid_grant', detail: 'unknown or used code' });
    codes.delete(form.get('code'));            // single use, always

    if (entry.clientId !== form.get('client_id')) {
      return json(res, 400, { error: 'invalid_grant', detail: 'wrong client' });
    }
    if (entry.redirectUri !== form.get('redirect_uri')) {
      return json(res, 400, { error: 'invalid_grant', detail: 'redirect_uri mismatch' });
    }
    // The point of PKCE, actually checked: the verifier must hash to the
    // challenge the authorize request carried.
    const verifier = form.get('code_verifier') || '';
    const hashed = b64url(createHash('sha256').update(verifier).digest());
    if (hashed !== entry.challenge) {
      return json(res, 400, { error: 'invalid_grant', detail: 'PKCE verification failed' });
    }
    console.log(`token: issued for ${entry.clientId} (resource=${entry.resource || 'none'})`);
    return issue(entry.clientId);
  }

  /* ── the MCP endpoint itself ─────────────────────────────── */

  if (path === '/mcp') {
    if (!bearer(req)) {
      console.log('mcp: 401');
      return json(res, 401, { error: 'invalid_token' }, {
        'WWW-Authenticate':
          `Bearer realm="OAuth", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      });
    }
    const rpc = JSON.parse((await body(req)) || '{}');
    const reply = result => json(res, 200, { jsonrpc: '2.0', id: rpc.id, result },
      { 'Mcp-Session-Id': 'mock-session' });

    if (rpc.method === 'initialize') {
      return reply({
        protocolVersion: rpc.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp-oauth', version: '1.0.0' },
      });
    }
    if (rpc.method === 'notifications/initialized') { res.writeHead(202, cors()); return res.end(); }
    if (rpc.method === 'tools/list') {
      return reply({
        tools: [{
          name: 'whoami',
          description: 'Says which token asked.',
          inputSchema: { type: 'object', properties: {} },
        }],
      });
    }
    if (rpc.method === 'tools/call') {
      return reply({ content: [{ type: 'text', text: 'You are signed in to the mock server.' }] });
    }
    return json(res, 200, { jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'no such method' } });
  }

  json(res, 404, { error: 'not_found', path });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock MCP (OAuth) on ${base}/mcp`);
  console.log(`access tokens last ${TOKEN_TTL_S}s, so refresh gets exercised`);
});
