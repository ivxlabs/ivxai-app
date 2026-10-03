#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// Packages the chat app as a browser extension, for Chrome, Firefox and Safari.
//
//   node scripts/extension-build.mjs                 all three
//   node scripts/extension-build.mjs chrome firefox  just those
//   node scripts/extension-build.mjs --no-build      reuse web/dist as it is
//
// The extension is the same build of the same app, with a manifest around it.
// Nothing is forked and nothing is injected: the app notices it is running on
// an extension origin by itself (see web/src/bridge.js, EXTENSION) and drops
// the bridge, which an extension page does not need.
//
// Output lands in packaging/extension/build/<target>/, with a zip beside it
// for the two targets that take one. Safari's build is a directory, because
// what Safari installs is an app — see packaging/extension/README.md.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(root, 'web');
const DIST = join(WEB, 'dist');
const OUT = join(root, 'packaging', 'extension', 'build');
const SRC = join(root, 'packaging', 'extension');

const TARGETS = ['chrome', 'firefox', 'safari'];
/* Toolbar sizes fill their canvas; 128 does not.
   The 128 is the one the Chrome Web Store shows, and it wants 96px of artwork
   centred in a 128px image with the remaining 16 a side left transparent — the
   store draws its own spacing, so a full-bleed icon sits noticeably larger than
   every other listing. The small ones are read at a glance in a toolbar and
   want every pixel they have. */
const ICON_SIZES = [16, 32, 48, 128];
const ICON_PADDING = { 128: 0.125 };   // 16px of 128, per side

const die = msg => { console.error(`extension: ${msg}`); process.exit(1); };
const log = msg => console.log(`extension: ${msg}`);

/* ── what every manifest says ──────────────────────────────── */

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
/* The listing's own words, from the one place they live. Chrome caps a
   manifest description at 132 characters, which is why branding.mjs checks the
   tagline against that limit rather than leaving it to be discovered here. */
const brand = JSON.parse(readFileSync(join(root, 'branding.json'), 'utf8'));

const icons = Object.fromEntries(ICON_SIZES.map(s => [s, `icons/ext-${s}.png`]));

/* Why the host permission is optional, and <all_urls> when it is asked for.

   Optional, because on install this extension can honestly say it reaches
   nothing. It never touches a page you visit; it calls the one address you
   typed into it, and most of those need no permission at all — a provider that
   answers with CORS headers is reachable from any page on the web, which is
   why the hosted build works. Only an endpoint that refuses browser origins
   needs more, and by then there is a specific host to name. web/src/
   host-access.js asks for that host, on the click that introduces it.

   <all_urls> as the *optional* set because the endpoint is the user's to
   choose: a runtime on a port only they use, a server they host, a company
   gateway. None of those can be enumerated here, and an extension cannot
   widen this set later without every existing install being asked again. What
   is granted out of it stays one host at a time. */
/* Page tools needs both of these, and neither shows a warning on install.

   `scripting` is what lets background.js register content.js at runtime, for
   the sites the person allowed and no others — which is the only reason this
   extension can put a bar on a page without declaring a content script here,
   and a declared content script is exactly the "read and change all your data
   on all websites" sentence the paragraph above is about.

   `storage` holds the three small things the page end needs and cannot ask
   the app for: which sites are allowed, the agent names its picker offers,
   and a request waiting for the panel to open. No chat, no key and no setting
   of any other kind ever leaves IndexedDB. */
const PAGE_TOOLS = ['scripting', 'storage'];

/* An MCP server that signs you in rather than handing you a token has to
   redirect a browser back somewhere afterwards, and no authorization server
   will redirect to `chrome-extension://`. `identity.launchWebAuthFlow` is the
   way out: the browser hands out an https address on its own domain and
   intercepts the redirect to it. That needs the `identity` permission.

   Optional wherever the browser allows it, so an install that never connects
   such a server is never asked. Firefox is not one of those browsers — it does
   not accept `identity` in `optional_permissions` and drops it on install,
   which `npm run ext:test` catches — so there it is required instead. Neither
   spelling adds a line to the install screen: `identity` carries no permission
   warning in either browser. Safari takes the key and has no `browser.identity`
   behind it, which mcp-oauth.js reports in a sentence rather than failing at a
   redirect nobody can read. */
const IDENTITY = { optional_permissions: ['identity'] };
const IDENTITY_REQUIRED = ['identity'];

const base = () => ({
  manifest_version: 3,
  name: brand.name,
  version: pkg.version,
  description: brand.tagline,
  homepage_url: 'https://ai.ivx.run/chat',
  icons,
  action: { default_title: brand.name, default_icon: icons },
  optional_host_permissions: ['<all_urls>'],
  ...IDENTITY,
  // 'wasm-unsafe-eval' is what lets WebLLM compile the model that runs inside
  // the browser. It is not 'unsafe-eval': no eval(), no new Function().
  content_security_policy: {
    extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
  },
});

/* The app opens in a side panel, which all three browsers spell differently
   and Safari does not have at all — `safari-web-extension-converter` rejects
   `sidebar_action`, `side_panel` and the `sidePanel` permission alike. So
   Safari's manifest asks for none of them and background.js opens a tab there
   instead. */
const manifests = {
  // Chrome's own panel, and the permission that unlocks it. background.js asks
  // for it to open on the toolbar click.
  chrome: () => ({
    ...base(),
    // declarativeNetRequestWithHostAccess: so background.js can drop the
    // Origin header off this extension's own calls. See the long note there
    // for why. The `WithHostAccess` spelling is the narrow one — it modifies
    // only requests to hosts already granted, which is exactly the reach this
    // extension has, and it asks for no warning of its own on install.
    permissions: ['sidePanel', 'declarativeNetRequestWithHostAccess', ...PAGE_TOOLS],
    side_panel: { default_path: 'index.html' },
    background: { service_worker: 'background.js' },
  }),

  // Firefox's equivalent, under an unrelated name and needing no permission.
  // It also wants a stable add-on id, and has no service worker for
  // extensions: MV3 there is an event page.
  firefox: () => ({
    ...base(),
    sidebar_action: {
      default_panel: 'index.html',
      default_title: brand.name,
      default_icon: icons,
    },
    // Firefox has declarativeNetRequest but does not apply it to an
    // extension's own requests; blocking webRequest is what works here, and is
    // still supported under MV3.
    permissions: ['webRequest', 'webRequestBlocking', ...PAGE_TOOLS, ...IDENTITY_REQUIRED],
    background: { scripts: ['background.js'] },
    // Required above instead; Firefox will not take it as optional.
    optional_permissions: undefined,
    /* `data_collection_permissions` is required of every new add-on since
       3 November 2025, and AMO rejects an upload without it. `none` is the
       declaration that nothing is collected or transmitted: this extension
       has no backend of its own, no telemetry and no analytics — what a chat
       reaches is the one endpoint its user typed in, under a key its user
       supplied, and nothing about that trip is kept or seen here.

       140 because that is the first Firefox with the built-in consent
       experience; below it the key is simply absent, and an add-on that
       cannot state its data collection in the browser's own words has to
       stage that conversation itself. 142 is the same line on Android. */
    browser_specific_settings: {
      gecko: {
        id: 'chat@ivx.run',
        strict_min_version: '140.0',
        data_collection_permissions: { required: ['none'] },
      },
      gecko_android: { strict_min_version: '142.0' },
    },
  }),

  /* No sidebar to ask for; the app opens in a tab. Safari takes the same
     declarativeNetRequest route as Chrome — it rejects webRequestBlocking
     outright — though whether it honours a modifyHeaders rule is the one claim
     here no script can check, since Safari cannot be driven. */
  safari: () => ({
    ...base(),
    permissions: ['declarativeNetRequestWithHostAccess', ...PAGE_TOOLS],
    background: { service_worker: 'background.js' },
  }),
};

/* ── building ──────────────────────────────────────────────── */

function buildWeb() {
  log('building the web app');
  execFileSync('npm', ['--prefix', 'web', 'run', 'build'], { cwd: root, stdio: 'inherit' });
}

/** The same mark the PWA and the desktop app use, at the sizes a toolbar wants. */
function renderIcons(dir) {
  mkdirSync(join(dir, 'icons'), { recursive: true });
  for (const size of ICON_SIZES) {
    execFileSync('node', [
      'tools/make-icons.mjs',
      join(dir, 'icons', `ext-${size}.png`),
      String(size),
      String(ICON_PADDING[size] ?? 0),
    ], { cwd: WEB, stdio: 'pipe' });
  }
}

/**
 * Strip what only makes sense on a web server.
 *
 * The service worker exists to make a hosted page work offline; an extension
 * already carries every file it will ever need, and `registerServiceWorker` in
 * main.js skips it here anyway, so shipping it would only leave a file nothing
 * ever loads. The PWA manifest describes how to install a web page as an app,
 * which is a thing this already is.
 */
function trimForExtension(dir) {
  rmSync(join(dir, 'sw.js'), { force: true });
  rmSync(join(dir, 'manifest.webmanifest'), { force: true });

  /* The icons a PWA install needs and an extension does not. The manifest
     points at ext-*.png, generated above; these are the sizes a home screen
     asks for, and `maskable` is a promise about being cropped to a circle that
     means nothing here. Shipping them would put 40 kB of unreachable files in
     front of a store reviewer. icon.svg stays — it is the page's favicon. */
  for (const name of ['icon-192.png', 'icon-512.png', 'maskable-512.png']) {
    rmSync(join(dir, 'icons', name), { force: true });
  }

  const indexPath = join(dir, 'index.html');
  let html = readFileSync(indexPath, 'utf8');
  html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
  // Would now point at a file that is not there, and means nothing outside iOS.
  html = html.replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
  writeFileSync(indexPath, html);
}

function buildTarget(target) {
  const dir = join(OUT, target);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  cpSync(DIST, dir, { recursive: true });
  trimForExtension(dir);
  renderIcons(dir);
  cpSync(join(SRC, 'background.js'), join(dir, 'background.js'));
  /* Shipped as a file but not declared in the manifest: background.js
     registers it for the sites the person allowed, and for nothing else. */
  cpSync(join(SRC, 'content.js'), join(dir, 'content.js'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifests[target](), null, 2) + '\n');

  // Safari installs an app, not a zip: the converter in README.md turns this
  // directory into an Xcode project, so a zip of it would only be in the way.
  if (target !== 'safari') {
    const zip = join(OUT, `ivxai-chat-${pkg.version}-${target}.zip`);
    rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.'], { cwd: dir });
    log(`${target}: ${dir}  ->  ${zip}`);
  } else {
    log(`${target}: ${dir}`);
  }
}

/* ── go ────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const chosen = args.filter(a => !a.startsWith('--'));
for (const t of chosen) if (!TARGETS.includes(t)) die(`unknown target "${t}"`);
const targets = chosen.length ? chosen : TARGETS;

if (!skipBuild) buildWeb();
if (!existsSync(DIST)) die('web/dist does not exist — run without --no-build');

mkdirSync(OUT, { recursive: true });
for (const target of targets) buildTarget(target);
log(`done: ${targets.join(', ')} (version ${pkg.version})`);
