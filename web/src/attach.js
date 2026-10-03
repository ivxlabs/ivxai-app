// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Attachments: pictures, video, audio and files that travel with a message.

   The bytes live in IndexedDB beside the chat, like everything else this app
   keeps. Nothing is uploaded anywhere, no attachment is ever fetched from a
   URL, and a file that is only attached and never sent — picked, then thought
   better of — is never written down at all.

   What reaches a model is decided per file, because models differ wildly in
   what they can read:

     - a picture goes as a picture, in whatever shape the provider speaks;
     - a text file goes as its text, which every model can read;
     - a PDF goes as a document where that exists, and is named otherwise;
     - a video, a sound file or a zip is named and described, never pretended
       to be readable.

   The last point is the important one. Sending a model the name of a video
   and letting it answer as though it had watched it is worse than useless, so
   the prompt says plainly what was attached and that its contents are not
   included. */

import * as store from './store.js';

/** Per file. Big enough for a phone video, small enough that one drop cannot
    silently fill the browser's storage quota. */
export const MAX_FILE_BYTES = 128 * 1024 * 1024;

/** How much of a text file is put in the prompt. Past this it is cut, and the
    cut is announced — a silently truncated file reads as a complete one. */
const TEXT_LIMIT = 40000;

/* Pictures are resized before they are sent, never before they are stored:
   the copy on screen and in an export stays the one that was attached. 1568px
   is the longest edge every vision model in use today works in; beyond it the
   extra pixels are resampled away at the other end, having been paid for on
   the way there. */
const IMAGE_MAX_EDGE = 1568;
const IMAGE_MAX_BYTES = 1024 * 1024;

const TEXTISH_MIME = new Set([
  'application/json', 'application/ld+json', 'application/xml', 'application/xhtml+xml',
  'application/javascript', 'application/x-javascript', 'application/typescript',
  'application/x-sh', 'application/x-yaml', 'application/yaml', 'application/toml',
  'application/sql', 'application/x-httpd-php', 'image/svg+xml',
]);

const TEXTISH_EXT = new Set([
  'txt', 'md', 'markdown', 'rst', 'log', 'csv', 'tsv', 'json', 'jsonl', 'ndjson',
  'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'scss', 'sass', 'less',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'pl', 'lua', 'r', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'sql', 'graphql', 'proto',
  'svg', 'diff', 'patch', 'dockerfile', 'makefile', 'gitignore',
]);

/* Extensions worth guessing a type for: a file dragged out of some archivers,
   and anything picked on a platform that hands over an empty `type`. */
const EXT_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac',
  pdf: 'application/pdf', zip: 'application/zip',
};

export const extensionOf = name => (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** The mime type the browser gave us, or the best guess from the name. */
const typeOf = file => file.type || EXT_MIME[extensionOf(file.name)] || '';

/**
 * Which of the four kinds a file is, which decides everything after: how it
 * is shown, and what a model is given.
 *
 * SVG is deliberately text and not an image: it is markup, every vision API
 * refuses it, and as text a model can actually read it.
 */
export function kindOf(type = '', name = '') {
  const mime = String(type).toLowerCase();
  const ext = extensionOf(name);
  if (mime === 'image/svg+xml' || ext === 'svg') return 'text';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('text/') || TEXTISH_MIME.has(mime) || TEXTISH_EXT.has(ext)) return 'text';
  return 'file';
}

export const ICONS = {
  image: 'ri-image-line',
  video: 'ri-movie-line',
  audio: 'ri-music-2-line',
  text: 'ri-file-text-line',
  file: 'ri-file-line',
};

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The one-line description under a thumbnail, and in an export. */
export const describe = att => `${att.name} · ${formatSize(att.size)}`;

/* ── making one ────────────────────────────────────────────── */

/**
 * Turn a picked, pasted or dropped file into a record, ready to be shown and
 * — once the message is actually sent — stored. Throws with a sentence the
 * composer can show when the file is too big to keep.
 */
export async function fromFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    throw new Error(`${file.name || 'That file'} is ${formatSize(file.size)}; ` +
      `the limit is ${formatSize(MAX_FILE_BYTES)}.`);
  }
  const type = typeOf(file);
  const kind = kindOf(type, file.name);
  const record = {
    id: store.uid(),
    name: file.name || defaultName(kind, type),
    type,
    size: file.size,
    kind,
    blob: file,
    createdAt: Date.now(),
  };

  if (kind === 'text') {
    let text = '';
    try { text = await file.text(); } catch { /* unreadable; it stays a file */ }
    record.truncated = text.length > TEXT_LIMIT;
    record.text = record.truncated ? text.slice(0, TEXT_LIMIT) : text;
  }
  if (kind === 'image') {
    const measured = await measureAndShrink(file);
    if (measured) {
      record.width = measured.width;
      record.height = measured.height;
      if (measured.blob) record.sendBlob = measured.blob;
    }
  }
  return record;
}

/** A pasted screenshot arrives with no name at all; it still needs one to be
    listed, downloaded and talked about. */
function defaultName(kind, type) {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const ext = Object.entries(EXT_MIME).find(([, mime]) => mime === type)?.[0]
    || (type.split('/')[1] || 'bin').replace(/[^a-z0-9]+/gi, '');
  return `${kind === 'image' ? 'pasted-image' : `pasted-${kind}`}-${stamp}.${ext}`;
}

/**
 * Read a picture's real size, and make the smaller copy that gets sent when
 * the original is larger than any model will use. The original is untouched.
 *
 * GIFs are left alone: a canvas keeps one frame, and a still of an animation
 * is not the thing that was attached.
 */
async function measureAndShrink(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;            // an image this browser cannot decode; send as-is
  }
  const { width, height } = bitmap;
  const edge = Math.max(width, height);
  const oversized = edge > IMAGE_MAX_EDGE || file.size > IMAGE_MAX_BYTES;
  if (!oversized || file.type === 'image/gif') {
    bitmap.close?.();
    return { width, height, blob: null };
  }

  const scale = Math.min(1, IMAGE_MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // JPEG has no transparency, and the default is black — which turns a
  // transparent logo into a black square. White is what a page would show.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  // Shrinking a small PNG can make it bigger; keep whichever is smaller.
  return { width, height, blob: blob && blob.size < file.size ? blob : null };
}

/** What a message carries about its attachments: enough to paint the thread
    without reading a single byte back out of the database. */
export const summarize = record => ({
  id: record.id,
  name: record.name,
  type: record.type,
  size: record.size,
  kind: record.kind,
  ...(record.width ? { width: record.width, height: record.height } : {}),
});

/* ── showing one ───────────────────────────────────────────── */

/* Object URLs, one per attachment, made on demand and kept for as long as the
   thread they are in is on screen. They are handed out by id rather than by
   record so two paints of the same message share one URL — and so they can
   all be let go at once when the chat changes. */
const urls = new Map();

export async function objectUrl(id) {
  if (urls.has(id)) return urls.get(id);
  const record = await store.getAttachment(id);
  if (!record?.blob) return null;
  const url = URL.createObjectURL(record.blob);
  urls.set(id, url);
  return url;
}

/** Let go of every URL handed out so far. Called when the thread on screen is
    replaced, at which point nothing is pointing at them any more. */
export function releaseAll() {
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

export const blobFor = async id => (await store.getAttachment(id))?.blob || null;

/* ── copying and moving ────────────────────────────────────── */

/** Save the records a message was sent with, stamped with where they belong. */
export async function persist(records, { convId, msgId }) {
  for (const record of records) {
    await store.putAttachment({ ...record, convId, msgId });
  }
}

/**
 * Copy one message's attachments onto another message — duplicating a chat.
 * Fresh ids, so deleting either copy leaves the other whole.
 * Returns the new list for the copied message.
 */
export async function copyTo(attachments, { convId, msgId }) {
  const copies = [];
  for (const meta of attachments || []) {
    const record = await store.getAttachment(meta.id);
    if (!record) continue;
    const copy = { ...record, id: store.uid(), convId, msgId };
    await store.putAttachment(copy);
    copies.push(summarize(copy));
  }
  return copies;
}

/* ── exports and imports ───────────────────────────────────── */

/* A backup that leaves the pictures behind is not a backup, so an export
   carries them base64-encoded inside the same JSON — which is what makes the
   file big, and is said plainly where the export is offered. Share links are
   the exception: a chat has to fit in a URL, so they travel without. */

export async function exportRecords(messages) {
  const wanted = new Set();
  for (const m of messages) for (const a of m.attachments || []) wanted.add(a.id);
  if (!wanted.size) return [];

  const out = [];
  for (const id of wanted) {
    const record = await store.getAttachment(id);
    if (!record) continue;
    const { blob, sendBlob, ...rest } = record;
    out.push({
      ...rest,
      data: await toBase64(blob),
      ...(sendBlob ? { sendData: await toBase64(sendBlob) } : {}),
    });
  }
  return out;
}

/**
 * Put exported attachments back. `remap` translates the ids a bundle was
 * written with into the ids it is being imported under — a shared chat gets
 * fresh ones, a backup keeps its own.
 */
export function restoreRecords(list = [], remap = {}) {
  return (list || []).map(entry => {
    const { data, sendData, ...rest } = entry;
    return {
      ...rest,
      id: remap.attachments?.[entry.id] ?? entry.id,
      convId: remap.conversations?.[entry.convId] ?? entry.convId,
      msgId: remap.messages?.[entry.msgId] ?? entry.msgId,
      blob: fromBase64(data, entry.type),
      ...(sendData ? { sendBlob: fromBase64(sendData, 'image/jpeg') } : {}),
    };
  }).filter(r => r.blob);
}

function fromBase64(data, type) {
  if (typeof data !== 'string' || !data) return null;
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  } catch {
    return null;
  }
}

/* ── what the model is given ───────────────────────────────── */

/* Encoding a picture is not free, and a chat re-sends its whole history on
   every round, so each attachment is encoded once per page load. */
const encoded = new Map();

async function toBase64(blob) {
  if (!blob) return '';
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buffer.length; i += 0x8000) {
    binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function encode(record) {
  if (encoded.has(record.id)) return encoded.get(record.id);
  const blob = record.sendBlob || record.blob;
  const data = await toBase64(blob);
  const part = { data, mediaType: record.sendBlob ? 'image/jpeg' : (record.type || 'application/octet-stream') };
  encoded.set(record.id, part);
  return part;
}

/** A text file, fenced so the model can tell the file from the sentence
    around it, and told when it was cut short. */
function textPart(record) {
  const ext = extensionOf(record.name);
  const fence = '```';
  const body = `${fence}${ext && ext.length <= 12 ? ext : ''}\n${record.text || ''}\n${fence}`;
  const cut = record.truncated
    ? `\n(Only the first ${TEXT_LIMIT.toLocaleString()} characters are included; the file is longer.)`
    : '';
  return { type: 'text', text: `[Attached file “${record.name}” (${formatSize(record.size)}):]\n${body}${cut}` };
}

/** Everything else: said, not sent. */
const notePart = record => ({
  type: 'text',
  text: `[Attached ${record.kind === 'file' ? 'file' : record.kind}: “${record.name}” ` +
    `(${record.type || 'unknown type'}, ${formatSize(record.size)}). ` +
    'Its contents are not included in this message and you cannot open it, ' +
    'so do not describe it as though you had.]',
});

/**
 * The content of one message, as provider-neutral parts. Returns the plain
 * string when there is nothing attached, so an ordinary chat sends exactly
 * the same request it always did.
 */
export async function contentFor(msg) {
  const list = msg.attachments || [];
  if (!list.length) return msg.content;

  const parts = [];
  const text = String(msg.content || '').trim();
  if (text) parts.push({ type: 'text', text });

  for (const meta of list) {
    const record = await store.getAttachment(meta.id);
    if (!record) {
      parts.push({ type: 'text',
        text: `[The attachment “${meta.name}” is no longer stored in this browser.]` });
      continue;
    }
    if (record.kind === 'image') {
      const { data, mediaType } = await encode(record);
      parts.push({ type: 'image', mediaType, data, name: record.name });
    } else if (record.kind === 'text') {
      parts.push(textPart(record));
    } else if (record.type === 'application/pdf') {
      const { data } = await encode(record);
      parts.push({ type: 'document', mediaType: 'application/pdf', data, name: record.name });
    } else {
      parts.push(notePart(record));
    }
  }
  return parts;
}

/** One line for a markdown export, where there is nowhere to put the file. */
export const exportLine = attachments =>
  (attachments || []).map(a => `_Attached ${a.kind}: ${describe(a)}_`).join('\n');
