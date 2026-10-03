#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Catch the one mistake a browser only reports when you reach the line.
 *
 * `popScreen()` was called in main.js for months without being imported: the
 * file parses, the bundler is happy, and the failure is a ReferenceError
 * thrown halfway through saving an agent — after the write, before the screen
 * updated. That is why saving looked like "it did not take": it took, and then
 * the handler died.
 *
 * So: for every local module, check that each name it calls is one it could
 * actually have. No parser, no dependency — imports, declarations and calls,
 * which is enough for the shape of this codebase.
 *
 *   node tools/check-imports.mjs
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

/** Anything a browser supplies, plus the shapes this project leans on. */
const GLOBALS = new Set([
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'structuredClone', 'alert', 'confirm',
  'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError', 'Symbol',
  'RegExp', 'Intl', 'BigInt', 'Proxy', 'Reflect', 'Function', 'AbortController',
  'Blob', 'File', 'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'URL',
  'URLSearchParams', 'TextEncoder', 'TextDecoder', 'Event', 'CustomEvent', 'Image',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'Worker', 'Notification',
  'crypto', 'indexedDB', 'localStorage', 'sessionStorage', 'navigator', 'location',
  'document', 'window', 'globalThis', 'console', 'performance', 'history', 'screen',
  'atob', 'btoa', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'import', 'super', 'require',
  'DOMParser', 'DOMException', 'CompressionStream', 'DecompressionStream',
  'createImageBitmap', 'ImageBitmap', 'OffscreenCanvas',
  'Uint8Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'ArrayBuffer',
  'DataView', 'ReadableStream', 'WritableStream', 'TransformStream', 'Element', 'Node',
  'HTMLElement', 'CSSStyleSheet', 'matchMedia', 'getComputedStyle', 'open', 'close',
]);

/** Keywords that are followed by a parenthesis and are not calls. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'new',
  'delete', 'void', 'await', 'yield', 'do', 'else', 'function', 'class', 'in', 'of',
  'case', 'throw', 'try', 'finally', 'const', 'let', 'var', 'async', 'get', 'set',
  'constructor', 'static',
]);

/**
 * Blank out everything that is not code: strings, templates, comments and
 * regex literals, keeping newlines so reported line numbers stay true.
 *
 * Scanned one character at a time rather than swept with regexes. Regexes get
 * this wrong in both directions — a URL inside a string looks like the start
 * of a comment, a character class looks like the start of another regex — and
 * both mistakes swallow real code and invent findings. Template literals nest
 * (`${items.map(x => `<li>${x}</li>`)}`), so the state is a stack.
 */
function strip(code) {
  const out = [];
  const blank = ch => (ch === '\n' ? '\n' : ' ');
  const stack = [{ template: false, depth: 0 }];
  let i = 0;
  let prev = '';                                  // last significant character

  while (i < code.length) {
    const top = stack[stack.length - 1];
    const ch = code[i];
    const next = code[i + 1];

    if (top.template) {
      if (ch === '\\') { out.push(' ', ' '); i += 2; continue; }
      if (ch === '`') { out.push(' '); i++; stack.pop(); prev = '`'; continue; }
      if (ch === '$' && next === '{') {
        out.push(' ', ' ');
        i += 2;
        stack.push({ template: false, depth: 0 });   // back to code, until its }
        prev = '(';
        continue;
      }
      out.push(blank(ch));
      i++;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') out.push(blank(code[i++]));
      continue;
    }
    if (ch === '/' && next === '*') {
      out.push(' ', ' ');
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) out.push(blank(code[i++]));
      out.push(' ', ' ');
      i += 2;
      continue;
    }
    if (ch === '`') { out.push(' '); i++; stack.push({ template: true, depth: 0 }); continue; }
    if (ch === "'" || ch === '"') {
      out.push(' ');
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === '\\') { out.push(' '); i++; }
        if (i < code.length) out.push(blank(code[i++]));
      }
      out.push(' ');
      i++;
      prev = ch;
      continue;
    }
    // A slash is a regex when what came before it cannot end an expression.
    if (ch === '/' && (prev === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prev))) {
      out.push(' ');
      i++;
      let inClass = false;
      while (i < code.length) {
        const c = code[i];
        if (c === '\\') { out.push(' ', ' '); i += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        else if (c === '\n') break;               // not a regex after all
        out.push(blank(c));
        i++;
      }
      out.push(' ');
      i++;
      prev = '/';
      continue;
    }
    // The `}` that closes a template's ${ … } hands the scanner back to it.
    if (ch === '}' && top.depth === 0 && stack.length > 1) {
      out.push(' ');
      i++;
      stack.pop();
      prev = '`';
      continue;
    }
    if (ch === '{') top.depth++;
    else if (ch === '}') top.depth--;

    out.push(ch);
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out.join('');
}

function declaredNames(code) {
  const names = new Set();
  const add = re => { for (const m of code.matchAll(re)) names.add(m[1]); };
  add(/(?:^|\s)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/g);
  add(/(?:^|\s)(?:export\s+)?(?:const|let|var)\s+([\w$]+)/g);
  add(/(?:^|\s)(?:export\s+)?class\s+([\w$]+)/g);
  // Destructured parameters: `function f({ find, render })`, `({ a, b }) => …`.
  for (const m of code.matchAll(/\(\s*\{([^{}]*)\}[^)]*\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().split('=')[0].trim().replace(/^\.\.\./, '');
      if (/^[\w$]+$/.test(name)) names.add(name);
    }
  }
  // Destructured bindings and parameters: too many shapes to model, so every
  // word bound by `{ a, b }` or `(a, b)` counts as declared somewhere.
  add(/\{\s*([\w,\s:]+?)\s*\}\s*=/g);
  for (const m of code.matchAll(/\{([^{}]*)\}\s*=/g)) {
    for (const part of m[1].split(',')) {
      const name = part.split(':').pop().trim().replace(/^\.\.\./, '');
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  for (const m of code.matchAll(/(?:^|[^\w$.])(\w+)\s*=>/g)) names.add(m[1]);
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=\s]/)[0].replace(/^\.\.\./, '');
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  for (const m of code.matchAll(/function\s*\*?\s*\w*\s*\(([^()]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[=\s]/)[0].replace(/^\.\.\./, '');
      if (/^\w+$/.test(name)) names.add(name);
    }
  }
  return names;
}

function importedNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/import\s+([^'"]+?)\s+from\s*['"][^'"]*['"]/g)) {
    const clause = m[1];
    for (const inner of clause.matchAll(/\{([^}]*)\}/g)) {
      for (const part of inner[1].split(',')) {
        const name = part.split(/\s+as\s+/).pop().trim();
        if (name) names.add(name);
      }
    }
    for (const star of clause.matchAll(/\*\s+as\s+(\w+)/g)) names.add(star[1]);
    const dflt = clause.replace(/\{[^}]*\}/g, '').replace(/\*\s+as\s+\w+/g, '').replace(/,/g, '').trim();
    if (/^\w+$/.test(dflt)) names.add(dflt);
  }
  return names;
}

let problems = 0;
for (const file of readdirSync(SRC).filter(f => f.endsWith('.js')).sort()) {
  const raw = readFileSync(join(SRC, file), 'utf8');
  const code = strip(raw);
  // Imports are read from the raw text: the scanner blanks the module path,
  // and an import with nothing between its quotes is no longer an import.
  const known = new Set([...declaredNames(code), ...importedNames(raw), ...GLOBALS]);

  const seen = new Set();
  for (const m of code.matchAll(/(?<![\w.$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || known.has(name) || seen.has(name)) continue;
    seen.add(name);
    // Report against the original text so the line number is the real one.
    const line = raw.split('\n').findIndex(l => new RegExp(`(?<![\\w.$])${name}\\s*\\(`).test(l)) + 1;
    console.error(`${file}:${line}  ${name}() is called but never imported or declared`);
    problems++;
  }
}

if (problems) {
  console.error(`\n${problems} undefined call${problems === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log('All calls resolve to something imported or declared.');
