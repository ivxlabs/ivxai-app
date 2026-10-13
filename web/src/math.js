// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* TeX math in replies: $…$, \(…\), $$…$$ and \[…\].

   KaTeX does the typesetting, bundled and served from this origin like
   everything else here. Its code is a chunk of its own, only fetched the first
   time a reply actually contains math — most chats never pay for it. Its
   stylesheet rides in the app's one CSS file (cssCodeSplit is off), and the
   fonts that stylesheet names are only downloaded once something uses them.

   Until it lands, math renders as its escaped source and is repainted in
   place when it arrives — see repaintMath. The same is true of anything KaTeX
   refuses to parse: a stray dollar sign stays the text it was.

   Security model, same as markdown.js: KaTeX escapes the source it is given,
   and with trust off it drops \href, \includegraphics and the other commands
   that could reach outside the expression. Model output can never inject
   HTML. */

import 'katex/dist/katex.min.css';

let katex = null;
let loading = null;

/* Same escape as markdown.js; duplicated because that module imports this one. */
const escapeHtml = s => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

/** Pull in KaTeX. Idempotent; repaints whatever was waiting on it. */
export function loadMath() {
  loading ??= import('katex')
    .then(mod => { katex = mod.default; repaintMath(); })
    .catch(() => { /* the source still reads without typesetting */ });
  return loading;
}

function typeset(tex, display) {
  try {
    return katex.renderToString(tex, {
      displayMode: display, throwOnError: true, trust: false, strict: 'ignore', output: 'htmlAndMathml',
    });
  } catch {
    return null;
  }
}

/**
 * Render one expression.
 *
 * @param {string} tex      the expression, without its delimiters, unescaped
 * @param {boolean} display block ($$…$$, \[…\]) rather than inline
 * @param {string} source   the expression as written, delimiters and all
 * @returns {string} HTML: typeset math, or the escaped source
 */
export function renderMath(tex, display, source) {
  if (!katex) {
    loadMath();
    return `<span class="math-pending" data-tex="${escapeHtml(tex)}"${display ? ' data-display' : ''}>${escapeHtml(source)}</span>`;
  }
  return typeset(tex, display) ?? escapeHtml(source);
}

/** Typeset the math that rendered before KaTeX arrived. Works on the DOM, so
    it keeps the scroll position and reaches every surface showing markdown. */
export function repaintMath(root = document) {
  if (!katex) return;
  for (const node of root.querySelectorAll('.math-pending')) {
    const html = typeset(node.dataset.tex, 'display' in node.dataset);
    if (html) node.outerHTML = html;          // KaTeX's own escaped output
    else node.classList.remove('math-pending');
  }
}
