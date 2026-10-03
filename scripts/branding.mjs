#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto
//
// The product copy lives in branding.json. This puts it everywhere it is read
// from, and refuses a release when any copy has drifted.
//
//   node scripts/branding.mjs           write it everywhere
//   node scripts/branding.mjs --check   fail if anything disagrees
//
// Same arrangement as scripts/version.mjs, for the same reason: a string that
// is typed out in nine places is a string that says nine different things
// within a year, and nobody notices because each one looked right on its own.
//
// What is deliberately NOT managed here:
//
//   crates/ivxai-bridge, packaging/homebrew/ivxai-bridge.rb
//     The bridge is a different program with a different job. Giving it the
//     chat client's tagline would be wrong, not consistent.
//
//   README.md, web/README.md, and the ai.ivx.run site
//     Prose, and in one case another repository. They open with the same first
//     sentence, but pinning whole paragraphs to a checker makes editing them a
//     fight. Listed at the bottom of this file so they are at least findable.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const brand = JSON.parse(readFileSync(join(root, 'branding.json'), 'utf8'));

const LIMITS = { tagline: 132, short: 80 };   // Chrome Web Store, F-Droid

const die = msg => { console.error(`branding: ${msg}`); process.exit(1); };

/* ── the places it goes ────────────────────────────────────────

   Each one is a file, a way to read the current value out of it, and a way to
   put a new one in. Regex rather than a parser so that formatting, key order
   and comments survive being rewritten. */

const jsonDescription = file => ({
  file,
  get: text => JSON.parse(text).description,
  set: (text, value) => text.replace(
    /("description"\s*:\s*")(?:[^"\\]|\\.)*(")/,
    (_, a, b) => a + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + b),
});

const targets = [
  // What the web app tells a search engine and a browser's install prompt.
  {
    file: 'web/index.html',
    want: 'tagline',
    get: t => /<meta name="description" content="([^"]*)">/.exec(t)?.[1],
    set: (t, v) => t.replace(/(<meta name="description" content=")[^"]*(">)/,
      (_, a, b) => a + v.replace(/"/g, '&quot;') + b),
  },
  { ...jsonDescription('web/public/manifest.webmanifest'), want: 'tagline' },

  // Package metadata. Not published to any registry, but it should not lie.
  { ...jsonDescription('package.json'), want: 'tagline' },
  { ...jsonDescription('web/package.json'), want: 'tagline' },
  {
    file: 'src-tauri/Cargo.toml',
    want: 'tagline',
    get: t => /^description = "([^"]*)"/m.exec(t)?.[1],
    set: (t, v) => t.replace(/^(description = ")[^"]*(")/m, (_, a, b) => a + v + b),
  },

  // The stores.
  {
    file: 'packaging/homebrew/ivxai-chat.rb',
    want: 'short',
    get: t => /^  desc "([^"]*)"/m.exec(t)?.[1],
    set: (t, v) => t.replace(/^(  desc ")[^"]*(")/m, (_, a, b) => a + v + b),
  },
  {
    file: 'fastlane/metadata/android/en-US/short_description.txt',
    want: 'short',
    get: t => t.trim(),
    set: (_, v) => v + '\n',
  },
  {
    file: 'fastlane/metadata/android/en-US/full_description.txt',
    want: 'description',
    get: t => t.trim(),
    set: (_, v) => v + '\n',
  },
  {
    file: 'fastlane/metadata/android/en-US/title.txt',
    want: 'name',
    get: t => t.trim(),
    set: (_, v) => v + '\n',
  },
];

/* The value each target should hold. `description` is wrapped for the one
   place that shows it as a wall of text. */
const wanted = key => {
  if (key === 'description') return brand.description.join('\n\n');
  const value = brand[key];
  if (LIMITS[key] && value.length > LIMITS[key]) {
    die(`branding.json: "${key}" is ${value.length} characters, and the limit is ${LIMITS[key]}`);
  }
  return value;
};

/* ── run ───────────────────────────────────────────────────── */

const check = process.argv.includes('--check');
const problems = [];
let written = 0;

for (const target of targets) {
  const path = join(root, target.file);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    problems.push(`${target.file} is missing`);
    continue;
  }

  const want = wanted(target.want);
  const have = target.get(text);

  if (have === want) continue;

  if (check) {
    problems.push(`${target.file} says ${JSON.stringify((have ?? '').slice(0, 60))}…`);
    continue;
  }

  const next = target.set(text, want);
  if (target.get(next) !== want) {
    die(`could not rewrite ${target.file} — the pattern in branding.mjs no longer matches it`);
  }
  writeFileSync(path, next);
  console.log(`branding: ${relative(root, path)}`);
  written++;
}

if (problems.length) {
  for (const p of problems) console.error(`branding: ${p}`);
  console.error('branding: run `npm run brand` and commit the result');
  process.exit(1);
}

console.log(check
  ? 'branding: everything matches branding.json'
  : `branding: ${written} file${written === 1 ? '' : 's'} updated, ${targets.length - written} already correct`);

/* Also carries this copy, by hand:
     README.md, web/README.md          opening paragraph
     packaging/extension/README.md     what the extension is
     ai.ivx.run                        zola.toml, content/_index.md,
                                       templates/index.html (hero)          */
