#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Submits the built Firefox extension to addons.mozilla.org as a new version
// of the listed add-on, with the source code its reviewers ask for.
//
//   node scripts/amo-publish.mjs <zip>                  submit it for review
//   node scripts/amo-publish.mjs <zip> --check          only validate it
//   node scripts/amo-publish.mjs <zip> --source <zip>   bring your own source
//
// Two things have to be in the environment, from Developer Hub → Manage API
// Keys on addons.mozilla.org:
//
//   AMO_JWT_ISSUER   the "JWT issuer", which looks like user:12345:678
//   AMO_JWT_SECRET   the "JWT secret"
//
// The add-on is found by the gecko id in the built manifest, so the listing on
// AMO has to carry that same id; AMO_ADDON_ID overrides it if it ever does not.
//
// Unlike the Chrome Web Store there is no draft: creating a listed version is
// submitting it, and it goes live once a reviewer or the automatic review
// passes it. --check stops after AMO's validator, which is the safe way to try
// the credentials.
//
// The source goes up because the build bundles and minifies, and AMO asks for
// the code behind anything a reviewer cannot read. Without --source it is
// `git archive HEAD` — the whole repository at the commit being released.
// packaging/extension/AMO-REVIEW.md in it is the reviewer's guide to
// rebuilding the zip; the approval notes below point there.

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://addons.mozilla.org/api/v5';

const die = msg => { console.error(`amo: ${msg}`); process.exit(1); };
const log = msg => console.log(`amo: ${msg}`);

/* What a reviewer needs to rebuild the zip from the source and compare. Kept
   here rather than in the listing so it travels with every version. */
const APPROVAL_NOTES = `\
The attached source is the whole repository at the commit this version was built from.

Build instructions, including how to diff the result against the uploaded zip:
packaging/extension/AMO-REVIEW.md in the source. In short, with Node.js 22:

  npm ci --prefix web
  node scripts/extension-build.mjs firefox

The output is packaging/extension/build/firefox/.`;

/* ── arguments and environment ─────────────────────────────── */

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const zipPath = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--source');
const checkOnly = args.includes('--check');
const sourceArg = flag('--source');

if (!zipPath) die('give me the zip to upload');
const isFile = p => { try { return statSync(p).isFile(); } catch { return false; } };
if (!isFile(zipPath)) die(`${zipPath} does not exist — run \`npm run ext:build firefox\` first`);
if (sourceArg && !isFile(sourceArg)) die(`${sourceArg} does not exist`);

const env = name => {
  const value = process.env[name]?.trim();
  if (!value) die(`${name} is not set — see packaging/extension/README.md`);
  return value;
};
const issuer = env('AMO_JWT_ISSUER');
const secret = env('AMO_JWT_SECRET');
const addonId = process.env.AMO_ADDON_ID?.trim() || geckoId();

/** The add-on id from the manifest the zip was built from. */
function geckoId() {
  const manifest = join(dirname(zipPath), 'firefox', 'manifest.json');
  if (!existsSync(manifest)) die(`no ${manifest} to read the add-on id from — set AMO_ADDON_ID`);
  const id = JSON.parse(readFileSync(manifest, 'utf8')).browser_specific_settings?.gecko?.id;
  return id || die(`${manifest} has no gecko id — set AMO_ADDON_ID`);
}

/* ── talking to AMO ────────────────────────────────────────── */

/**
 * A fresh token per request. AMO refuses one that lives longer than five
 * minutes, and the wait for the validator alone can take that long.
 */
function jwt() {
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    iss: issuer,
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
  })}`;
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`;
}

/** AMO's errors are either {detail} or a map of field → messages. */
function describe(json) {
  if (json?.detail) return json.detail;
  if (json?.error) return json.error;
  const fields = Object.entries(json || {})
    .map(([k, v]) => `${k}: ${[].concat(v).join(' ')}`);
  return fields.length ? fields.join('; ') : null;
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `JWT ${jwt()}` },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = describe(json) || String(res.status);
    if (res.status === 401) {
      die(`${message}\n  AMO refused the API key. Check AMO_JWT_ISSUER and AMO_JWT_SECRET, ` +
        'and that the key has not been revoked in Developer Hub → Manage API Keys.');
    }
    if (res.status === 403 || res.status === 404) {
      die(`${message}\n  No add-on ${addonId} that this key may submit to. The listing on AMO ` +
        'has to carry the same gecko id as the manifest, and the key has to belong to one ' +
        'of its authors.');
    }
    if (/already exists|been used/i.test(message)) {
      die(`${message}\n  AMO never takes a version number twice, even one that was ` +
        'deleted. Bump it with `npm run bump patch`, rebuild, and tag again.');
    }
    die(message);
  }
  return json;
}

const file = (path, type) => new Blob([readFileSync(path)], { type });

async function upload() {
  log(`uploading ${basename(zipPath)} for ${addonId}`);
  const form = new FormData();
  form.append('upload', file(zipPath, 'application/zip'), basename(zipPath));
  form.append('channel', 'listed');
  let status = await call('/addons/upload/', { method: 'POST', body: form });

  // The validator runs after the upload is taken, and takes its time.
  for (let tries = 0; !status.processed; tries++) {
    if (tries === 120) die('the validator had not finished after ten minutes');
    await new Promise(r => setTimeout(r, 5_000));
    status = await call(`/addons/upload/${status.uuid}/`);
  }

  const messages = status.validation?.messages || [];
  for (const m of messages.filter(m => m.type === 'warning')) {
    console.warn(`amo: warning: ${[].concat(m.message).join(' ')}${m.file ? ` (${m.file})` : ''}`);
  }
  if (!status.valid) {
    const errors = messages.filter(m => m.type === 'error')
      .map(m => `  ${[].concat(m.message).join(' ')}${m.file ? ` (${m.file})` : ''}`);
    die(`the validator refused it:\n${errors.join('\n') || JSON.stringify(status.validation)}`);
  }
  log(`valid${status.version ? `, version ${status.version}` : ''}`);
  return status.uuid;
}

/** The source to attach: the one given, or the repository at HEAD. */
function sourceArchive() {
  if (sourceArg) return { path: sourceArg, cleanup: () => {} };
  const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'],
    { cwd: root, encoding: 'utf8' }).trim();
  if (dirty) {
    console.warn('amo: warning: the working tree has uncommitted changes, and the source ' +
      'sent is HEAD without them — it will not rebuild into this zip exactly');
  }
  const dir = mkdtempSync(join(tmpdir(), 'amo-source-'));
  const path = join(dir, 'source.zip');
  execFileSync('git', ['archive', '--format=zip', '-o', path, 'HEAD'], { cwd: root });
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function submit(uuid) {
  const source = sourceArchive();
  try {
    const mb = (statSync(source.path).size / 1024 / 1024).toFixed(1);
    log(`submitting for review, with ${mb} MB of source`);
    const form = new FormData();
    form.append('upload', uuid);
    form.append('approval_notes', APPROVAL_NOTES);
    form.append('source', file(source.path, 'application/zip'), 'source.zip');
    const version = await call(`/addons/addon/${encodeURIComponent(addonId)}/versions/`,
      { method: 'POST', body: form });
    log(`submitted version ${version.version}, ${version.file?.status || 'awaiting review'}`);
    log('it goes live once review passes it, which may be minutes or days');
  } finally {
    source.cleanup();
  }
}

/* ── go ────────────────────────────────────────────────────── */

const uuid = await upload();
if (checkOnly) log('validated only — drop --check to submit it');
else await submit(uuid);
