// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* A small Markdown subset renderer.

   Security model: the source is escaped before any markup is generated, and
   every tag in the output is one this file wrote. Model output can therefore
   never inject HTML. URLs are scheme-checked before they reach an href.
   Fenced code is the one exception, and only in form: highlight.js escapes
   the source itself and adds nothing but its own <span> wrappers. Math is
   the other, for the same reason: KaTeX escapes what it typesets. */

import { highlightCode } from './highlight.js';
import { renderMath } from './math.js';

const escapeHtml = s => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

function safeUrl(raw) {
  const url = raw.trim().replace(/^<|>$/g, '');
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;   // unknown scheme -> drop
  return url;                                           // relative path
}

/* ── inline ────────────────────────────────────────────────── */

function inline(text) {
  const codes = [];
  let out = text.replace(/(`+)([\s\S]*?)\1/g, (m, ticks, body) => {
    codes.push(`<code>${body.trim()}</code>`);
    return `\u0000C${codes.length - 1}\u0000`;
  });

  // Images become plain links: this app never auto-loads remote assets.
  // The target allows one level of balanced parens, so javascript:alert(1)
  // is consumed whole (and then rejected) rather than leaving a stray ")".
  out = out.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, alt, url) => {
    const href = safeUrl(url);
    return href
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${alt || 'image'}</a>`
      : (alt || '');
  });

  out = out.replace(/\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, url) => {
    const href = safeUrl(url);
    return href
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`
      : label;
  });

  // Bare URLs that are not already inside an href we just wrote.
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g,
    (m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>`);

  out = out
    .replace(/\*\*\*([^\s*][\s\S]*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^\s*][^*]*?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])__([^\s_][\s\S]*?)__(?!\w)/g, '$1<strong>$2</strong>')
    .replace(/(^|[^\w_])_([^\s_][^_]*?)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~([^\s~][\s\S]*?)~~/g, '<del>$1</del>');

  return out.replace(/\u0000C(\d+)\u0000/g, (m, i) => codes[Number(i)]);
}

/* ── blocks ────────────────────────────────────────────────── */

const RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RE_HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const RE_QUOTE = /^ {0,3}(?:&gt;|>) ?(.*)$/;   // '>' is escaped before block parsing
const RE_LI = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function renderList(lines, start) {
  // Returns [html, nextIndex]. Deeper indentation recurses into a sublist.
  const first = lines[start].match(RE_LI);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = lines[i].match(RE_LI);
    if (!m) {
      // A blank line followed by another item keeps the list open.
      if (lines[i].trim() === '' && lines[i + 1] && RE_LI.test(lines[i + 1])) { i++; continue; }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const [html, next] = renderList(lines, i);
      items[items.length - 1] = (items[items.length - 1] || '') + html;
      i = next;
      continue;
    }
    if (/\d/.test(m[2]) !== ordered) break;

    let body = m[3];
    const task = body.match(/^\[([ xX])\]\s+(.*)$/);
    let prefix = '';
    if (task) {
      prefix = `<input type="checkbox" disabled${task[1] === ' ' ? '' : ' checked'}> `;
      body = task[2];
    }
    // Fold continuation lines into the item.
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '' && !RE_LI.test(lines[j]) &&
           lines[j].search(/\S/) > baseIndent) {
      body += ' ' + lines[j].trim();
      j++;
    }
    items.push(prefix + inline(body));
    i = j;
  }

  const tag = ordered ? 'ol' : 'ul';
  const firstNum = Number(first[2].replace(/\D/g, ''));
  const startAttr = ordered && firstNum !== 1 ? ` start="${firstNum}"` : '';
  return [`<${tag}${startAttr}>${items.map(x => `<li>${x}</li>`).join('')}</${tag}>`, i];
}

function renderTable(lines, start) {
  const cells = row => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
  const head = cells(lines[start]);
  const aligns = lines[start + 1].trim().replace(/^\||\|$/g, '').split('|').map(c => {
    const t = c.trim();
    if (/^:.*:$/.test(t)) return ' class="text-center"';
    if (/:$/.test(t)) return ' class="text-end"';
    return '';
  });
  let i = start + 2;
  const body = [];
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    body.push(cells(lines[i]));
    i++;
  }
  const th = head.map((c, n) => `<th${aligns[n] || ''}>${c}</th>`).join('');
  const trs = body
    .map(r => `<tr>${r.map((c, n) => `<td${aligns[n] || ''}>${c}</td>`).join('')}</tr>`)
    .join('');
  return [`<table><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`, i];
}

function renderBlocks(src) {
  const lines = src.split('\n');
  const out = [];
  let para = [];

  const flush = () => {
    if (para.length) {
      out.push(`<p>${para.map(inline).join('<br>')}</p>`);
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim() === '') { flush(); continue; }
    if (/^\u0000B\d+\u0000$/.test(line.trim())) { flush(); out.push(line.trim()); continue; }

    let m;
    if ((m = line.match(RE_HEADING))) {
      flush();
      const level = m[1].length;
      out.push(`<h${level}>${inline(m[2])}</h${level}>`);
      continue;
    }
    if (RE_HR.test(line)) { flush(); out.push('<hr>'); continue; }

    if (RE_QUOTE.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && (m = lines[i].match(RE_QUOTE))) { buf.push(m[1]); i++; }
      i--;
      out.push(`<blockquote>${renderBlocks(buf.join('\n'))}</blockquote>`);
      continue;
    }

    if (RE_LI.test(line)) {
      flush();
      const [html, next] = renderList(lines, i);
      out.push(html);
      i = next - 1;
      continue;
    }

    if (line.includes('|') && lines[i + 1] && lines[i + 1].includes('-') && RE_TABLE_SEP.test(lines[i + 1])) {
      flush();
      const [html, next] = renderTable(lines, i);
      out.push(html);
      i = next - 1;
      continue;
    }

    para.push(line);
  }
  flush();
  return out.join('');
}

/* ── math ──────────────────────────────────────────────────── */

/* Display math first, then inline. A code span is matched only so that it is
   skipped — `$PATH` is shell, not TeX. A single $ follows Pandoc's rule so
   prices survive: the opening one is followed by a non-space, the closing one
   preceded by a non-space and not followed by a digit, so "$5 and $10" stays
   text. */
const RE_MATH = new RegExp([
  /(`+)(?:(?!\n\n)[\s\S])*?\1/.source,
  /\$\$([\s\S]+?)\$\$/.source,
  /\\\[([\s\S]+?)\\\]/.source,
  /\\\(([\s\S]+?)\\\)/.source,
  /(?<![\\$\w])\$(?=[^\s$])((?:\\.|[^$\\\n])+?)(?<=[^\s\\])\$(?![\d$\w])/.source,
].join('|'), 'g');

/* ── entry point ───────────────────────────────────────────── */

export function renderMarkdown(source) {
  if (!source) return '';
  const blocks = [];
  const text = String(source).replace(/\u0000/g, '').replace(/\r\n?/g, '\n');

  // Fenced code is pulled out first so nothing inside it is interpreted. An
  // unterminated fence is normal while a response is still streaming.
  const withoutCode = text.replace(
    // The trailing (?![\s\S]) is "end of input", not "end of line" — with the
    // m flag a plain $ would close the block at the first newline.
    /^ {0,3}(`{3,}|~{3,})([^\n]*)\n?([\s\S]*?)(?:^ {0,3}\1[`~]*[ \t]*$|(?![\s\S]))/gm,
    (m, fence, info, body) => {
      // The header names what the colours are for, so it reports the language
      // highlighting actually used — which for an unlabelled fence is the one
      // detection settled on.
      const { html, language, pending } = highlightCode(body.replace(/\n$/, ''), info.trim().split(/\s+/)[0] || '');
      blocks.push(
        '<div class="code-block">' +
          `<div class="code-head"><span>${escapeHtml(language)}</span>` +
          '<button class="code-copy" type="button" data-copy>Copy</button></div>' +
          `<pre><code class="hljs"${pending ? ' data-hl="pending"' : ''}>${html}</code></pre>` +
        '</div>'
      );
      return `\n\u0000B${blocks.length - 1}\u0000\n`;
    }
  );

  // Math comes out next, before escaping, for the same reason: \frac{a}{b}
  // and x_1 * y_2 must not be read as markup. An unclosed $$ while streaming
  // shows as text until its partner arrives.
  const maths = [];
  const withoutMath = withoutCode.replace(RE_MATH, (m, ticks, dd, bracket, paren, single) => {
    if (ticks) return m;
    const display = dd !== undefined || bracket !== undefined;
    maths.push(renderMath((dd ?? bracket ?? paren ?? single).trim(), display, m));
    return `\u0000M${maths.length - 1}\u0000`;
  });

  return renderBlocks(escapeHtml(withoutMath))
    .replace(/<p>\u0000B(\d+)\u0000<\/p>|\u0000B(\d+)\u0000/g,
      (m, a, b) => blocks[Number(a ?? b)] || '')
    .replace(/\u0000M(\d+)\u0000/g, (m, i) => maths[Number(i)] || '');
}
