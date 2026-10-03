// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Share links. A chat is zipped, the zip is base64-encoded into the URL
   fragment, and the recipient's browser unzips it back into their own
   IndexedDB.

   The fragment (not a query parameter) is the point: browsers never send it
   to the server, so hosting the app stays as blind to shared chats as it is
   to the ones stored locally. The chat travels inside the link even through
   a shortener — which is why the shortener must be the user's choice, and
   why the share screen says so plainly.

   The fragment payload is a real zip file, so anyone curious about what a
   link carries can decode it and open it with any unzip tool. */

import * as bridge from './bridge.js';
import * as store from './store.js';

const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* One-file zip writer: deflate-raw when the browser has it (and it helps),
   stored bytes otherwise. Every modern browser has CompressionStream since
   2023, but the fallback keeps older ones working for free. */
async function zipOne(name, text) {
  const enc = new TextEncoder();
  const nameBytes = enc.encode(name);
  const content = enc.encode(text);

  let method = 0, data = content;
  if (typeof CompressionStream !== 'undefined') {
    try {
      const stream = new Blob([content]).stream().pipeThrough(new CompressionStream('deflate-raw'));
      const packed = new Uint8Array(await new Response(stream).arrayBuffer());
      if (packed.length < content.length) { method = 8; data = packed; }
    } catch { /* stored bytes are always valid; compression is only a favour */ }
  }

  const crc = crc32(content);
  const out = new Uint8Array(98 + nameBytes.length * 2 + data.length);
  const view = new DataView(out.buffer);
  let o = 0;

  view.setUint32(o, 0x04034b50, true); o += 4;   // local file header
  view.setUint16(o, 20, true); o += 2;           // version needed
  view.setUint16(o, 0, true); o += 2;            // flags
  view.setUint16(o, method, true); o += 2;
  view.setUint16(o, 0, true); o += 2;            // time
  view.setUint16(o, DOS_DATE, true); o += 2;
  view.setUint32(o, crc, true); o += 4;
  view.setUint32(o, data.length, true); o += 4;  // compressed size
  view.setUint32(o, content.length, true); o += 4;
  view.setUint16(o, nameBytes.length, true); o += 2;
  view.setUint16(o, 0, true); o += 2;            // extra length
  out.set(nameBytes, o); o += nameBytes.length;
  out.set(data, o); o += data.length;

  view.setUint32(o, 0x02014b50, true); o += 4;   // central directory
  view.setUint16(o, 20, true); o += 2;           // version made by
  view.setUint16(o, 20, true); o += 2;           // version needed
  view.setUint16(o, 0, true); o += 2;            // flags
  view.setUint16(o, method, true); o += 2;
  view.setUint16(o, 0, true); o += 2;            // time
  view.setUint16(o, DOS_DATE, true); o += 2;
  view.setUint32(o, crc, true); o += 4;
  view.setUint32(o, data.length, true); o += 4;
  view.setUint32(o, content.length, true); o += 4;
  view.setUint16(o, nameBytes.length, true); o += 2;
  view.setUint16(o, 0, true); o += 2;            // extra
  view.setUint16(o, 0, true); o += 2;            // comment
  view.setUint16(o, 0, true); o += 2;            // disk start
  view.setUint16(o, 0, true); o += 2;            // internal attrs
  view.setUint32(o, 0, true); o += 4;            // external attrs
  view.setUint32(o, 0, true); o += 4;            // local header offset
  out.set(nameBytes, o); o += nameBytes.length;

  view.setUint32(o, 0x06054b50, true); o += 4;   // end of central directory
  view.setUint16(o, 0, true); o += 2;            // this disk
  view.setUint16(o, 0, true); o += 2;            // cd disk
  view.setUint16(o, 1, true); o += 2;            // entries here
  view.setUint16(o, 1, true); o += 2;            // entries total
  view.setUint32(o, 46 + nameBytes.length, true); o += 4;
  view.setUint32(o, 30 + nameBytes.length + data.length, true); o += 4;
  view.setUint16(o, 0, true); o += 2;            // comment length
  return out;
}

/* The reader side of the same format — one known file, fixed offsets. */
async function unzipOne(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error('not a zip');
  const method = view.getUint16(8, true);
  const csize = view.getUint32(18, true);
  const usize = view.getUint32(22, true);
  const nameLen = view.getUint16(26, true);
  const data = bytes.subarray(30 + nameLen, 30 + nameLen + csize);
  let content;
  if (method === 0) {
    content = data;
  } else {
    if (typeof DecompressionStream === 'undefined') throw new Error('no decompression');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    content = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (content.length !== usize) throw new Error('corrupt');
  return new TextDecoder().decode(content);
}

/* URL-safe base64 so the payload survives being pasted through shorteners
   and messengers unharmed. */
function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  let s = text.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* Where a shared link points when this page's own address cannot be used.
   The extension's origin is a `chrome-extension://<id>` that exists only in
   the browser that installed it, so a link built there would open for nobody
   — not even for the same person on another machine. The hosted app reads the
   identical fragment, so pointing at it costs the recipient nothing and is the
   only address that actually resolves. Overridden by Settings → Sharing. */
const PUBLIC_APP = 'https://ai.ivx.run/chat';

/** Zip the bundle and fold it into a share link. The base is the configured
    share URL when one is set — so a link built on this machine can open at
    the public place the app is hosted — else this very page.
    Same shape as the JSON export, so the two stay interchangeable. */
export async function buildLink({ conversation, messages, baseUrl = '' }) {
  const bundle = {
    app: 'ivx-ai-chat', version: 1, exportedAt: new Date().toISOString(),
    conversation, messages,
  };
  const zip = await zipOne('chat.json', JSON.stringify(bundle));
  const base = String(baseUrl || '').trim().replace(/\/+$/, '')
    || (bridge.EXTENSION ? PUBLIC_APP : `${location.origin}${location.pathname}`);
  return `${base}#s=${b64url(zip)}`;
}

/** Read a share link, if this page was opened with one. Null when absent,
    malformed, or undecodable — the caller tells the user which. */
export async function readSharedLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return null;
  try {
    // Some shorteners percent-encode the fragment on the way through.
    const raw = m[1].includes('%') ? decodeURIComponent(m[1]) : m[1];
    const bundle = JSON.parse(await unzipOne(unb64url(raw)));
    if (!bundle?.conversation || !Array.isArray(bundle.messages)) return null;
    return bundle;
  } catch {
    return null;
  }
}

/** Save a shared chat under fresh ids, so importing the same link twice
    never overwrites the first copy. Returns the new conversation id. */
export async function importShared(bundle) {
  const now = Date.now();
  const { draft, archived, ...conv } = bundle.conversation;
  conv.id = store.uid();
  conv.createdAt = now;
  conv.updatedAt = now;
  conv.pinned = false;
  const messages = bundle.messages.map(({ pending, threadId, ...m }) => ({
    ...m, id: store.uid(), convId: conv.id,
  }));
  await store.importBundle({ conversations: [conv], messages, kv: [] });
  return conv.id;
}

/* TinyURL is the one shortener, and it is opt-in: shortening hands the whole
   link — and the chat rides inside it — to a third party. The toggle lives
   under Settings → Privacy & data; the caller hides the button while it is
   off, and no shortener is ever contacted without it. */
export async function shortenUrl(url) {
  // Not via the hosted bridge: the link carries the chat, and one third party
  // seeing it is the price of shortening, not two.
  const [endpoint] = bridge.apply(
    `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, {}, { hosted: false });
  try {
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const short = (await res.text()).trim();
    if (!short) throw new Error('empty answer');
    return { short, name: 'TinyURL' };
  } catch (err) {
    throw new Error(`TinyURL did not answer from the browser (${err.message}). ` +
      'Copy the full link and paste it into tinyurl.com instead.');
  }
}