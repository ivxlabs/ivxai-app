# Building this add-on from source

This is the source for the Firefox add-on **ivx/ai Chat** (`chat@ivx.run`),
uploaded to AMO as `ivxai-chat-<version>-firefox.zip`.

Source is provided because the shipped JavaScript is bundled and minified by
[Vite](https://vite.dev/) (MIT, open source, runs locally). Nothing here is
obfuscated, and no build step fetches code from anywhere but the npm registry
using the committed lockfile.

## Build environment

Each version is built by GitHub Actions (`ubuntu-latest`, Node.js 22) from the
tagged commit this archive was made from. The build is meant to be
deterministic, so any recent Node.js should give the same bytes; Node 22 is
the version it is built with.

The only generated binaries are the PNG toolbar icons, which
`web/tools/make-icons.mjs` draws from scratch using `node:zlib` — no image
library. zlib is compiled into Node itself rather than taken from the host, so
the icon bytes do not depend on the operating system.

Node.js is the only tool you need to install: <https://nodejs.org/en/download>.
`zip` and `git` are used by the packaging scripts and are present on a default
Ubuntu desktop install.

## Build

Two commands, from the root of this archive:

```sh
npm ci --prefix web
node scripts/extension-build.mjs firefox
```

`npm ci` installs from `web/package-lock.json`, which is included, so the
dependency versions are pinned to the ones the upload was built with.

The result is:

```
packaging/extension/build/firefox/          <- diff this against the uploaded zip
packaging/extension/build/ivxai-chat-<version>-firefox.zip
```

To compare:

```sh
mkdir -p /tmp/uploaded && unzip -q ivxai-chat-<version>-firefox.zip -d /tmp/uploaded
diff -r /tmp/uploaded packaging/extension/build/firefox && echo "no differences"
```

## What the build does

`scripts/extension-build.mjs` is the whole build. It runs the ordinary Vite
build of `web/`, copies `web/dist` into a per-browser directory, drops the two
files that only make sense on a web server (`sw.js` and the PWA manifest),
renders the icons, adds `packaging/extension/background.js` and
`content.js` (neither is bundled or minified), and writes
`manifest.json`. The manifest is generated rather than stored — see the
`firefox` entry near the top of that file for every key it sets and why.

There is no separate extension codebase. The extension is the same build of
the same app as the hosted version at <https://ai.ivx.run/chat>; the app
detects the extension origin itself (`EXTENSION` in `web/src/bridge.js`).

### One unusual step: the .wasm files

`assets/webllm-tokenizers-*.wasm` and `assets/webllm-xgrammar-*.wasm` are not
built here and are not ours. `@mlc-ai/web-llm` (Apache-2.0) ships them as
Emscripten `-sSINGLE_FILE` builds, meaning each WebAssembly module is a base64
`data:` URI embedded in a string literal inside its `lib/index.js`. That put
5.6 MB of base64 into a single script, which `addons-linter` refuses to parse
(`FILE_TOO_LARGE`).

So the build writes each blob out as the `.wasm` file it already was and
replaces the literal with that file's URL. This is the `externalWasm` plugin
in `web/vite.config.js`; the bytes are copied out unmodified. To confirm that
for yourself, after `npm ci`:

```sh
node -e '
  const fs=require("fs"),c=require("crypto");
  const s=fs.readFileSync("web/node_modules/@mlc-ai/web-llm/lib/index.js","utf8");
  const re=/"data:application\/octet-stream;base64,([A-Za-z0-9+\/=]{10000,})"/g;
  for(let m;m=re.exec(s);){const b=Buffer.from(m[1],"base64");
    console.log(b.length, c.createHash("sha256").update(b).digest("hex"));}'
```

and compare with `shasum -a 256 packaging/extension/build/firefox/assets/*.wasm`.
They match exactly.

## What else is in this package

This repository builds three things from one app. Only the first is relevant
to this review; the rest is included so nothing is withheld:

- `web/` — the app, and `scripts/` + `packaging/extension/` — the add-on.
  **This is the add-on.**
- `src-tauri/`, `crates/`, `Cargo.toml` — a desktop and Android build of the
  same app (Rust/Tauri), and `ivxai-bridge`, an optional local helper. Not built
  by the commands above and not part of the uploaded zip.
- `fastlane/`, `packaging/fdroid/`, `packaging/homebrew/`, `.github/` — store
  metadata and CI for those other targets.

## Third-party code in the add-on

All open source, all installed from npm at the versions pinned in
`web/package-lock.json`, none modified:

| Library | Licence | Where it shows up |
|---|---|---|
| [highlight.js](https://github.com/highlightjs/highlight.js) | BSD-3-Clause | `assets/highlight-langs-*.js`, and code blocks in `assets/index-*.js` |
| [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) | Apache-2.0 | `assets/lib-*.js` and the two `.wasm` files |
| [Halfmoon](https://github.com/halfmoonui/halfmoon) | MIT | `assets/style-*.css` |
| [IBM Plex](https://github.com/IBM/plex) (via @fontsource) | SIL OFL 1.1 | the `.woff2` files |

The licence notices are re-attached to the built bundles by the
`licenceNotices` plugin in `web/vite.config.js`, since the minifier drops
banner comments.

## Licence

This add-on is GPL-3.0-or-later. See `LICENSE`.
