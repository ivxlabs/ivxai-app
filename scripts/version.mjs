#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The version lives in one place: [workspace.package] in Cargo.toml.
//
//   src-tauri/Cargo.toml   inherits it with version.workspace = true
//   crates/ivxai-bridge      the same, and prints it as `ivxai-bridge --version`
//   tauri.conf.json        has no version field, so Tauri falls back to Cargo
//   package.json           is not read at build time, but should not lie
//   web/package.json       the chat client, stamped into its About screen
//   web/src/mcp.js         what it calls itself to an MCP server
//
// so this script writes Cargo.toml and mirrors it into the other three. The
// shell and the page it carries ship together, so they are one version, and
// --check fails if any of the four has drifted.
//
//   node scripts/version.mjs 0.2.0     set it
//   node scripts/version.mjs patch     bump it (also: minor, major)
//   node scripts/version.mjs --check   fail if anything disagrees
//   node scripts/version.mjs --check v0.2.0   ...including a release tag

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CARGO = join(root, 'Cargo.toml');
const PKG = join(root, 'package.json');
const WEB_PKG = join(root, 'web', 'package.json');
const WEB_MCP = join(root, 'web', 'src', 'mcp.js');

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
// The version inside [workspace.package] — never a dependency's version.
const IN_WORKSPACE = /(\[workspace\.package\][^[]*?\bversion\s*=\s*")([^"]+)(")/s;
// Rewritten in place rather than through JSON.stringify, to leave key order
// and formatting exactly as they were.
const PKG_VERSION = /("version"\s*:\s*")([^"]+)(")/;
const MCP_VERSION = /(CLIENT_INFO = \{[^}]*\bversion:\s*')([^']+)(')/;

const die = msg => { console.error(`version: ${msg}`); process.exit(1); };

const readCargo = () => {
  const text = readFileSync(CARGO, 'utf8');
  const m = text.match(IN_WORKSPACE);
  if (!m) die('no version found under [workspace.package] in Cargo.toml');
  return { text, version: m[2] };
};

const readPkg = () => JSON.parse(readFileSync(PKG, 'utf8'));

function bump(current, kind) {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function check(tag) {
  const { version } = readCargo();
  const pkg = readPkg().version;
  const problems = [];
  if (pkg !== version) problems.push(`package.json is ${pkg}, Cargo.toml is ${version}`);

  const webPkg = JSON.parse(readFileSync(WEB_PKG, 'utf8')).version;
  if (webPkg !== version) problems.push(`web/package.json is ${webPkg}, Cargo.toml is ${version}`);
  const webMcp = readFileSync(WEB_MCP, 'utf8').match(MCP_VERSION);
  if (webMcp && webMcp[2] !== version) {
    problems.push(`web/src/mcp.js says ${webMcp[2]}, Cargo.toml is ${version}`);
  }
  if (tag) {
    const wanted = tag.replace(/^v/, '');
    if (wanted !== version) problems.push(`tag is ${tag}, Cargo.toml is ${version}`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`version: ${p}`);
    console.error('version: run `npm run bump <version>` and commit before tagging');
    process.exit(1);
  }
  console.log(`version: ${version}, everything agrees`);
}

function set(next) {
  if (!SEMVER.test(next)) die(`"${next}" is not a semver version`);

  const { text, version: current } = readCargo();
  writeFileSync(CARGO, text.replace(IN_WORKSPACE, `$1${next}$3`));

  for (const file of [PKG, WEB_PKG]) {
    const pkgText = readFileSync(file, 'utf8');
    if (!PKG_VERSION.test(pkgText)) die(`no version field in ${file}`);
    writeFileSync(file, pkgText.replace(PKG_VERSION, `$1${next}$3`));
  }

  // What the chat client announces to an MCP server on initialize.
  const mcpText = readFileSync(WEB_MCP, 'utf8');
  if (MCP_VERSION.test(mcpText)) {
    writeFileSync(WEB_MCP, mcpText.replace(MCP_VERSION, `$1${next}$3`));
  }

  // Cargo.lock records the workspace crates' versions too.
  try {
    execFileSync('cargo', ['update', '--workspace', '--offline'], { cwd: root, stdio: 'pipe' });
  } catch {
    console.warn('version: could not refresh Cargo.lock — run `cargo update --workspace`');
  }

  console.log(`version: ${current} -> ${next}`);
  console.log('version: commit this, then tag that commit v' + next);
}

const [arg, tag, ...rest] = process.argv.slice(2);
if (rest.length) die(`unexpected argument "${rest[0]}"`);
if (!arg) console.log(readCargo().version);
else if (arg === '--check') check(tag);
else if (['major', 'minor', 'patch'].includes(arg)) {
  // `bump patch 0.2.2` reads as two conflicting instructions — say so rather
  // than silently bumping and dropping the version the caller asked for.
  if (tag) die(`"${arg}" takes no argument — say \`bump ${arg}\` or \`bump ${tag}\`, not both`);
  set(bump(readCargo().version, arg));
} else {
  if (tag) die(`unexpected argument "${tag}"`);
  set(arg);
}
