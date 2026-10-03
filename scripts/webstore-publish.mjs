#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Uploads the built Chrome extension to the Chrome Web Store, and optionally
// submits it for review.
//
//   node scripts/webstore-publish.mjs <zip>                     upload as a draft
//   node scripts/webstore-publish.mjs <zip> --publish           ...and submit it
//   node scripts/webstore-publish.mjs <zip> --publish --staged  ...but hold it
//                                                               once approved
//
// Three things have to be in the environment, all from the one-time setup in
// packaging/extension/README.md:
//
//   WEBSTORE_SERVICE_ACCOUNT  the service account's JSON key — its contents,
//                             or a path to the file when running by hand
//   WEBSTORE_PUBLISHER_ID     Publisher → Settings in the developer dashboard
//   WEBSTORE_ITEM_ID          the 32-letter id in the item's store URL
//
// This is the v2 API. v1.1 stops answering on 15 October 2026, and v2 is also
// the one that takes a service account: a machine identity with no consent
// screen and no refresh token to expire, which is what a release job wants.
//
// The store is not a file host: uploading replaces the draft of an item that
// already exists, so the first version has to go up by hand — that is the one
// that carries the listing, the screenshots and the privacy answers, none of
// which this API can write. Everything after it is this script.
//
// Publishing does not make anything live. It submits for review, which takes
// anywhere from an hour to a week, and the store decides.

import { readFileSync, statSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const API = 'https://chromewebstore.googleapis.com';
const item = (publisher, id) => `publishers/${publisher}/items/${id}`;

const die = msg => { console.error(`webstore: ${msg}`); process.exit(1); };
const log = msg => console.log(`webstore: ${msg}`);

/* ── arguments and environment ─────────────────────────────── */

const args = process.argv.slice(2);
const zipPath = args.find(a => !a.startsWith('--'));
const shouldPublish = args.includes('--publish');
const staged = args.includes('--staged');

if (!zipPath) die('give me the zip to upload');
try {
  if (!statSync(zipPath).isFile()) die(`${zipPath} is not a file`);
} catch {
  die(`${zipPath} does not exist — run \`npm run ext:build\` first`);
}

const env = name => {
  const value = process.env[name]?.trim();
  if (!value) die(`${name} is not set — see packaging/extension/README.md`);
  return value;
};
const key = serviceAccount(env('WEBSTORE_SERVICE_ACCOUNT'));
const name = item(env('WEBSTORE_PUBLISHER_ID'), env('WEBSTORE_ITEM_ID'));

/** The JSON key, whether it came as the secret's contents or as a path. */
function serviceAccount(value) {
  const text = value.startsWith('{') ? value
    : existsSync(value) ? readFileSync(value, 'utf8')
    : die('WEBSTORE_SERVICE_ACCOUNT is neither JSON nor a file that exists');
  let json;
  try { json = JSON.parse(text); } catch { die('WEBSTORE_SERVICE_ACCOUNT is not valid JSON'); }
  if (json.type !== 'service_account' || !json.client_email || !json.private_key) {
    die('WEBSTORE_SERVICE_ACCOUNT is not a service account key — create one under ' +
      'IAM & Admin → Service Accounts → Keys → Add key → JSON');
  }
  return json;
}

/* ── talking to the store ──────────────────────────────────── */

/**
 * Sign a JWT with the service account's key and trade it for an access token.
 *
 * Done by hand rather than through google-auth-library: it is one signature
 * and one POST, and not worth a dependency for a script that runs per release.
 */
async function accessToken() {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const tokenUrl = key.token_uri || 'https://oauth2.googleapis.com/token';
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: key.client_email,
    scope: SCOPE,
    aud: tokenUrl,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A deleted or disabled key, most likely; the account itself rarely goes.
    die(`could not sign in as ${key.client_email}: ` +
      `${json.error_description || json.error || res.status}`);
  }
  return json.access_token;
}

/** One call to the store, with its error made readable. */
async function call(token, path, { method = 'POST', body, headers = {} } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.error?.message || JSON.stringify(json) || String(res.status);
    // The two that need explaining. Both come back as a bare 403 or 404.
    if (res.status === 403 || res.status === 404) {
      die(`${message}\n  The store refused ${key.client_email} for ${name}. Check that ` +
        'this service account is added under Account in the developer dashboard, and ' +
        'that WEBSTORE_PUBLISHER_ID and WEBSTORE_ITEM_ID are right.');
    }
    if (/already exists|same version|version.*(greater|higher)/i.test(message)) {
      const version = versionOf();
      die(`the store already has ${version ? `version ${version}` : 'this version'} ` +
        'of this item. Bump it with `npm run bump patch`, rebuild, and tag again.');
    }
    die(message);
  }
  return json;
}

/**
 * The version this zip is for, from its name, for the error above.
 *
 * Read from the filename rather than the manifest inside, which is deflated
 * and so not there to be grepped — the first attempt at this quietly matched
 * nothing and printed "version that".
 */
function versionOf() {
  const m = /-(\d+\.\d+\.\d+[^-]*)-/.exec(basename(zipPath));
  return m ? m[1] : null;
}

async function upload(token) {
  const zip = readFileSync(zipPath);
  log(`uploading ${basename(zipPath)} (${(zip.length / 1024 / 1024).toFixed(1)} MB) to ${name}`);

  let { uploadState: state, crxVersion } = await call(token, `/upload/v2/${name}:upload`, {
    body: zip,
    headers: { 'Content-Type': 'application/zip' },
  });

  // The store may take the package and check it afterwards; wait it out
  // rather than submit something that is about to be refused.
  for (let tries = 0; state === 'IN_PROGRESS'; tries++) {
    if (tries === 30) die('the upload was still being processed after five minutes');
    await new Promise(r => setTimeout(r, 10_000));
    state = (await call(token, `/v2/${name}:fetchStatus`, { method: 'GET' })).lastAsyncUploadState;
  }
  if (state !== 'SUCCEEDED') die(`upload failed, state ${state}`);
  log(`uploaded${crxVersion ? ` version ${crxVersion}` : ''}`);
}

async function publish(token) {
  log(`submitting for review${staged ? ', to be held once approved' : ''}`);
  const json = await call(token, `/v2/${name}:publish`, {
    body: JSON.stringify({ publishType: staged ? 'STAGED_PUBLISH' : 'DEFAULT_PUBLISH' }),
    headers: { 'Content-Type': 'application/json' },
  });
  for (const w of json.warningInfo ? [].concat(json.warningInfo) : []) {
    console.warn(`webstore: warning: ${w.description || w.reason || JSON.stringify(w)}`);
  }
  log(`submitted, state ${json.state}`);
  log('review takes anywhere from an hour to a week; the store decides when it goes live');
}

/* ── go ────────────────────────────────────────────────────── */

const token = await accessToken();
await upload(token);
if (shouldPublish) await publish(token);
else log('uploaded as a draft — pass --publish to submit it');
