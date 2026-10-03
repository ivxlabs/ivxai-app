// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { copyFile, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, posix, relative, sep } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Stamps the built asset list into public/sw.js.
 *
 * Deliberately not vite-plugin-pwa/Workbox: the whole premise of this app is
 * that every line of shipped JavaScript is auditable and ours. A precache
 * manifest is a list of strings, so generating it takes ~30 lines rather than
 * a runtime library.
 */
function serviceWorkerPrecache() {
  let outDir = 'dist';
  let base = '/';

  const collect = async (dir, prefix = '') => {
    const entries = await readdir(dir, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) out.push(...await collect(join(dir, entry.name), rel));
      else out.push(rel);
    }
    return out;
  };

  return {
    name: 'ivx:sw-precache',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
      base = config.base;
    },
    async closeBundle() {
      const swPath = join(outDir, 'sw.js');
      let source;
      try {
        source = await readFile(swPath, 'utf8');
      } catch {
        this.warn('sw.js not found in the output; skipping precache injection');
        return;
      }

      const files = (await collect(outDir))
        .map(f => f.split(sep).join('/'))
        .filter(f => f !== 'sw.js')
        .filter(f => !f.endsWith('.map'))
        // fontsource ships a .woff fallback beside every .woff2; no browser
        // that can run this app will ever ask for it, so keep it out of the
        // install payload.
        .filter(f => !f.endsWith('.woff'))
        // A lazily loaded vendor asset can dwarf the whole shell: WebLLM's
        // chunk is 430 kB and the wasm it fetches another 4.2 MB. Precaching
        // those would tax every install with bytes most users never touch.
        // They stay ordinary same-origin assets, so the fetch handler caches
        // them on first use instead — offline still works, once used.
        .filter(f => !f.endsWith('.wasm'))
        .filter(f => statSync(join(outDir, f)).size <= PRECACHE_MAX_BYTES)
        .sort();

      const urls = files.map(f => `${base}${f}`.replace(/\/{2,}/g, '/'));

      /* Over contents, not names. Rolldown hashes a chunk before the plugins
         below rewrite it, so a fix to what externalWasm() splices in ships
         under the chunk's old filename — and a version taken from filenames
         alone would not move, leaving every existing install to serve the
         broken chunk out of a cache activate() has no reason to purge. */
      const digest = createHash('sha256');
      for (const f of files) {
        digest.update(f).update(createHash('sha256').update(await readFile(join(outDir, f))).digest());
      }
      const version = digest.digest('hex').slice(0, 12);

      await writeFile(swPath, source
        .replace('__CACHE_VERSION__', version)
        .replace('__PRECACHE_MANIFEST__', JSON.stringify(urls, null, 2)));

      this.info?.(`sw.js: precaching ${urls.length} files (${version})`);
    },
  };
}

/**
 * Pulls WebLLM's WebAssembly out of the JavaScript bundle.
 *
 * web-llm ships the XGrammar and tokenizer runtimes as Emscripten
 * `-sSINGLE_FILE` builds: each wasm module is a base64 `data:` URI living in a
 * string literal. That is 5.6 MB of a 6.0 MB vendor chunk, and it is why
 * addons-linter rejects the Firefox package with FILE_TOO_LARGE — Mozilla
 * will not parse a script over 5 MB, so the add-on cannot be reviewed at all.
 *
 * Each blob becomes a real .wasm file beside the chunk, the literal becomes
 * that file's URL, and the module gets back the fetch that `-sSINGLE_FILE`
 * compiled out of it. The browser then downloads 5.6 MB of wasm it can cache
 * on its own, instead of decoding 7.5 MB of base64 on the main thread every
 * time the chunk loads.
 */
function externalWasm() {
  /* Only a literal with a payload: the bare prefix appears on its own too, as
     the constant Emscripten compares a path against. */
  const INLINE_WASM = /(["'`])data:application\/octet-stream;base64,([A-Za-z0-9+/=]{1000,})\1/g;
  /* What Emscripten does next with a path that is not a data: URI — prefix it
     with the directory the module was loaded from. An absolute URL neither
     needs that nor survives it, so the call goes. Both shapes the minifier has
     been seen to emit; if it grows a third, `scriptDirectory` is empty for a
     module script anyway and the call is a no-op. */
  const LOCATE_FILE = /^(?:;?(\w+)\((\w+)\)\|\|\(\2=\w+\(\2\)\);|;?if\(!(\w+)\((\w+)\)\)\{\4=\w+\(\4\);?\})/;

  /** A name that says what the binary is and changes when the binary does. */
  const nameFor = bytes => {
    const text = bytes.toString('latin1');
    const label = text.includes('xgrammar') ? 'xgrammar'
      : text.includes('sentencepiece') ? 'tokenizers'
      : 'runtime';
    return `webllm-${label}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.wasm`;
  };

  /* `-sSINGLE_FILE` does not merely inline the binary, it removes the code
     that could load one: `getBinaryPromise` collapses to a wrapper around a
     sync `getBinarySync` that reads data: URIs and throws on anything else.
     That throw is what a user sees as "Aborted(both async and sync fetching
     of the wasm failed)", so a module handed a URL has to be handed a fetch
     as well. web-llm's third wasm, tvmjs_runtime, is an ordinary build that
     already has one; its getBinaryPromise has a real body and so does not
     match here. */
  const SYNC_GETTER = /function (\w+)\(\w+\)\{[\s\S]{0,400}?both async and sync fetching of the wasm failed`\}/g;
  const BINARY_PROMISE = /function (\w+)\((\w+)\)\{return Promise\.resolve\(\)\.then\(\(\)=>(\w+)\(\2\)\)\}/g;

  /** Gives every collapsed getBinaryPromise a network path back. */
  const restoreFetch = code => {
    const sync = new Set(Array.from(code.matchAll(SYNC_GETTER), m => m[1]));
    let patched = 0;
    /* The sync path is tried first and still answers for a data: URI and for
       a caller that pre-set Module.wasmBinary; only what it cannot do becomes
       a fetch, and its own error is still what surfaces when there is no
       fetch to fall back on. */
    const out = code.replace(BINARY_PROMISE, (whole, name, arg, getBinary) => {
      if (!sync.has(getBinary)) return whole;
      patched++;
      return `function ${name}(${arg}){`
        + `try{return Promise.resolve(${getBinary}(${arg}))}`
        + `catch(e){if(typeof fetch!="function")throw e}`
        + `return fetch(${arg},{credentials:"same-origin"}).then(r=>{`
        + `if(!r.ok)throw new Error("failed to load wasm binary file at "+${arg});`
        + `return r.arrayBuffer()})}`;
    });
    return [out, patched];
  };

  let outDir = 'dist';
  return {
    name: 'ivx:external-wasm',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    async closeBundle() {
      const dir = join(outDir, 'assets');
      let entries = [];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      for (const name of entries.filter(f => f.endsWith('.js'))) {
        const file = join(dir, name);
        const code = await readFile(file, 'utf8');
        let out = '';
        let cursor = 0;
        let lifted = 0;

        INLINE_WASM.lastIndex = 0;
        for (let match; (match = INLINE_WASM.exec(code));) {
          const bytes = Buffer.from(match[2], 'base64');
          const wasm = nameFor(bytes);
          await writeFile(join(dir, wasm), bytes);

          out += code.slice(cursor, match.index);
          out += `new URL(${JSON.stringify(`./${wasm}`)},import.meta.url).href`;
          lifted++;
          cursor = match.index + match[0].length;
          const locate = code.slice(cursor).match(LOCATE_FILE);
          /* The guard is a statement, and the `;` opening it is what ended
             the declaration the literal was part of. Dropping the match whole
             would run the URL straight into the next statement. */
          if (locate) {
            cursor += locate[0].length;
            out += ';';
          }

          this.info?.(`${wasm}: ${(bytes.length / 1e6).toFixed(1)} MB lifted out of ${name}`);
        }

        if (!cursor) continue;
        const [body, patched] = restoreFetch(out + code.slice(cursor));
        /* A URL with no fetch to go with it is a build that looks fine and
           dies the first time someone picks a local model, so the two have to
           come out even. */
        if (patched !== lifted) {
          this.error(`assets/${name}: lifted ${lifted} wasm binaries out but `
            + `gave a fetch back to ${patched} of them`);
        }
        await writeFile(file, body);

        /* Splicing an expression into minified vendor code is the kind of
           thing that is either right or a syntax error, and a syntax error
           here would only show up as WebLLM failing to load, months later. So
           ask Node. The copy is because `--check` reads a bare .js as script,
           and this is a module. */
        const probe = join(dir, '.syntax-check.mjs');
        await copyFile(file, probe);
        try {
          execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
        } catch (err) {
          this.error(`assets/${name} is not valid JavaScript after lifting its wasm out: `
            + String(err.stderr || err).trim().split('\n').pop());
        } finally {
          rmSync(probe, { force: true });
        }
      }

      /* The same build is what gets packaged for Mozilla, so the limit that
         only AMO enforces is a build invariant here. Better a failed build
         than a rejected upload. */
      for (const name of await readdir(dir)) {
        if (!name.endsWith('.js')) continue;
        const size = statSync(join(dir, name)).size;
        if (size > MAX_REVIEWABLE_JS_BYTES) {
          this.error(`assets/${name} is ${(size / 1e6).toFixed(1)} MB; `
            + `addons-linter refuses to parse a script over ${MAX_REVIEWABLE_JS_BYTES / 1e6} MB`);
        }
      }
    },
  };
}

/**
 * Puts the licence notices back on the built assets.
 *
 * The bundle is the form most people actually receive, and it has to say what
 * it is. Rolldown's minifier drops banner comments, and it also strips
 * Halfmoon's own MIT notice — which that licence requires be kept — so both
 * are prepended here after the bundle is written.
 */
function licenceNotices() {
  const js = '/*! ivx/ai Chat | GPL-3.0-or-later | Copyright (C) 2026 0xcrypto\n' +
    ' * Source: https://github.com/ivxlabs/chat\n' +
    ' * Bundles highlight.js (BSD-3-Clause, Copyright (c) 2006 Ivan Sagalaev and others) */\n';
  const css = '/*! ivx/ai Chat | GPL-3.0-or-later | Copyright (C) 2026 0xcrypto\n' +
    ' * Source: https://github.com/ivxlabs/chat\n' +
    ' * Bundles Halfmoon CSS v2.0.2 (MIT, Copyright (c) 2023 Tahmid Khan)\n' +
    ' * and IBM Plex (SIL Open Font License 1.1, Copyright IBM Corp.) */\n';

  let outDir = 'dist';
  return {
    name: 'ivx:licence-notices',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    async closeBundle() {
      const dir = join(outDir, 'assets');
      let entries = [];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const banner = name.endsWith('.js') ? js : name.endsWith('.css') ? css : null;
        if (!banner) continue;
        const file = join(dir, name);
        const body = await readFile(file, 'utf8');
        if (body.startsWith('/*!')) continue;
        await writeFile(file, banner + body);
      }
    },
  };
}

/** Actual installed versions, so the About screen cannot drift from reality. */
const installed = name => {
  try {
    return JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
  } catch {
    return '';
  }
};

/* Chunks bigger than this are left out of the service worker's install
   manifest and cached on first use instead — see the filter above. */
const PRECACHE_MAX_BYTES = 2 * 1024 * 1024;

/* addons-linter reports FILE_TOO_LARGE above this and stops reading, which
   fails the AMO upload outright — see externalWasm(). */
const MAX_REVIEWABLE_JS_BYTES = 5 * 1024 * 1024;

export default defineConfig({
  define: {
    __VERSIONS__: JSON.stringify({
      app: JSON.parse(readFileSync('package.json', 'utf8')).version,
      vite: installed('vite'),
      halfmoon: installed('halfmoon'),
      plex: installed('@fontsource/ibm-plex-sans'),
      webllm: installed('@mlc-ai/web-llm'),
      hljs: installed('highlight.js'),
    }),
  },
  // Relative base so the build can be dropped in any directory of any host.
  base: './',
  plugins: [externalWasm(), licenceNotices(), serviceWorkerPrecache()],
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 0,   // keep fonts and icons as real, cacheable files
    reportCompressedSize: false,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
});
