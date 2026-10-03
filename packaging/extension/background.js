// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Opening the app, and nothing else.

   The extension packages the whole chat app and runs it as an ordinary page on
   the extension's own origin. That origin carries the manifest's host
   permissions, so the page reaches every provider itself — there is no
   proxying to do here, no messages to relay and no state worth keeping.

   Where it opens is the only thing that differs between browsers, and all
   three disagree:

     Chrome    `sidePanel`, a panel the browser owns. Asking it to open on the
               toolbar click means the click never reaches us — which is why
               the listener below is not Chrome's path.
     Firefox   `sidebar_action`, an unrelated API for the same idea. Firefox
               puts it in the sidebar menu on its own; the toolbar button
               toggles it from here.
     Safari    Neither exists. The converter says so outright, so the app opens
               in a tab there. A popup would be closer in shape and worse in
               practice: it closes the moment you click away, which for a
               window you type into is the wrong trade.

   Written for both dialects: Chrome and Safari run this as a service worker,
   Firefox as an event page. Neither keeps it alive, so nothing here may assume
   it survives. */

const api = globalThis.browser ?? globalThis.chrome;

/* ── not sending an Origin ─────────────────────────────────────

   A browser attaches `Origin` to every cross-origin POST, and an extension
   page is no exception: ours goes out as `Origin: chrome-extension://<id>`.
   Plenty of local runtimes check that header against a list they were given —
   Ollama's OLLAMA_ORIGINS is the one people meet — and answer 403 to anything
   not on it. The browser permits the request; the server refuses it. So the
   call still fails, still needs the bridge, and fails in a way that reads like
   a rejected API key.

   Which misses what the header is for. `Origin` exists so a server can tell
   that some *other* website told a browser to make this request. Nothing told
   this extension anything: it is the client, the person installed it, and they
   typed the address themselves. A native client in the same position — curl,
   Ollama's own CLI — sends no Origin at all, and is trusted for it. So this
   removes ours, and the endpoint sees what it would have seen from any program
   on the machine.

   The scoping is the part that has to be right. A rule that stripped Origin
   from every request the browser makes would take a real protection away from
   every site the person visits, so both branches below match on the request
   having come from this extension and nothing else. Both are verified against
   a control in scripts/extension-test.mjs: an ordinary page's Origin survives.

   Two branches because no API does this everywhere. Chrome and Safari get
   declarativeNetRequest; Firefox has it too but does not apply it to an
   extension's own requests, and still allows blocking webRequest, which Safari
   in turn does not support. The manifest grants one permission or the other,
   so the feature check below picks the branch that was provisioned.

   And the app is told the answer rather than left to assume it. None of this
   runs unless this script does, and nothing guarantees that it has: an MV3
   background script is started for an event, the side panel opening is not one,
   and a rule that was never registered fails exactly like a rejected key. So
   the result is kept as a promise, the app asks for it at boot, and asking is
   itself what starts this script if it was not running. */

const STRIP_ORIGIN_RULE = 1;

/** Resolves to whether this browser is now dropping our `Origin`. */
const originStripped = stripOrigin();

async function stripOrigin() {
  if (api.declarativeNetRequest?.updateSessionRules) {
    // Session rules, not static ones: `initiatorDomains` needs the extension
    // id, which is only knowable at runtime.
    try {
      await api.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [STRIP_ORIGIN_RULE],
        addRules: [{
          id: STRIP_ORIGIN_RULE,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'origin', operation: 'remove' }],
          },
          condition: {
            initiatorDomains: [api.runtime.id],
            resourceTypes: ['xmlhttprequest'],
          },
        }],
      });
      return true;
    } catch {
      return false;   // provider calls still work, minus origin-checking ones
    }
  }

  // Registered synchronously — nothing above this point awaits on the branch
  // that gets here — so the listener is in place before the app can send a
  // request past it.
  if (api.webRequest?.onBeforeSendHeaders) {
    const SELF = api.runtime.getURL('');
    api.webRequest.onBeforeSendHeaders.addListener(
      details => {
        // originUrl is the page that made the call. Anything that is not one
        // of ours is left exactly as it was.
        if (!details.originUrl?.startsWith(SELF)) return {};
        return {
          requestHeaders: details.requestHeaders.filter(h => h.name.toLowerCase() !== 'origin'),
        };
      },
      { urls: ['<all_urls>'] },
      ['blocking', 'requestHeaders'],
    );
    return true;
  }

  return false;
}

/* The app's one question, answered once the rule above has actually landed.
   `true` here is the app's licence to call a provider directly; `false`, or no
   answer at all, is what sends it to the bridge instead of into a 403. */
api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'ivx:origin-strip') return false;
  originStripped.then(stripped => sendResponse({ stripped }));
  return true;   // the answer comes later
});

/* Chrome only. Set at every worker start rather than on install: the setting
   persists, but re-asserting it is free and survives a profile that has lost
   it. After this the toolbar button opens the panel directly and
   `action.onClicked` never fires here. */
api.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  .catch(() => { /* older Chrome without the API; the tab fallback covers it */ });

/* Safari's fallback only. Remembered so a second click returns to the app
   instead of opening a second copy of it — two tabs share one IndexedDB, and
   watching the other tab's chats appear underneath you is not a good
   introduction to the thing.

   Deliberately not persisted. When the worker is torn down this is forgotten
   and the next click opens a fresh tab, which costs one spare tab. The
   alternative is the "tabs" permission, which the browser shows on install as
   "read your browsing history" — too much to ask for a convenience this
   small. */
let openTabId = null;

/** True when the app was already open and has now been brought to the front. */
async function focusExisting() {
  if (openTabId === null) return false;
  try {
    const tab = await api.tabs.get(openTabId);
    await api.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) await api.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    // Closed, or in a window that has since gone away.
    openTabId = null;
    return false;
  }
}

api.action.onClicked.addListener(async () => {
  // Firefox: toggle the sidebar. Allowed here because a toolbar click is the
  // user gesture the API requires.
  if (api.sidebarAction?.toggle) {
    await api.sidebarAction.toggle();
    return;
  }

  // Safari: no sidebar of any kind, so the app gets a tab.
  if (await focusExisting()) return;
  const tab = await api.tabs.create({ url: api.runtime.getURL('index.html') });
  openTabId = tab.id;
});

api.tabs.onRemoved.addListener(id => {
  if (id === openTabId) openTabId = null;
});

/* ── page tools ────────────────────────────────────────────────

   Select text on a page and a small bar offers to summarize it, translate it
   or put a question about it to an agent; focus a text field and a chip offers
   to write into it. content.js is what draws those; this is what carries them
   to the app and the app's answer back.

   The part worth reading twice is that content.js is *not* in the manifest.
   A content script declared there comes with host permissions declared there,
   and for a tool that could be used on any site that reads, on install, as
   "read and change all your data on all websites" — the sentence this
   extension has gone to some length not to say, and does not mean: page tools
   are off until a person turns them on, and reach one site at a time after
   that. So the script is registered at runtime for the sites they allowed,
   which is a permission the browser asks about at the moment there is a site
   to name. See web/src/page-tools.js for the end that asks.

   Three hops, because none of the three parties can reach the others:

     page → here   a click in content.js, which is also the user gesture that
                   lets the panel be opened at all.
     here → app    the request is queued and the app is nudged. Queued rather
                   than sent, because the click that opens the panel is also
                   the click whose request it carries, and the panel is not
                   loaded yet; the app claims the queue when it boots and on
                   every nudge after.
     app → page    one message, `ivx:page-write`, carrying the text a `<write>`
                   tool call produced. The app never writes what the model
                   *said* — only what it asked for through the tool. */

const SITES_KEY = 'ivx:page-sites';    // match patterns page tools may run on
const AGENTS_KEY = 'ivx:agents';       // what content.js's agent picker offers
const QUEUE_KEY = 'ivx:page-queue';    // requests the app has not claimed yet
const SCRIPT_ID = 'ivx-page-tools';

/* Session storage where there is one: a queued request is about a click that
   just happened and means nothing tomorrow. Not every browser this ships to
   has it, and `local` holds the site list and the agent names in either case —
   those are settings, and are meant to outlive the session. */
const session = api.storage?.session ?? api.storage?.local ?? null;
const local = api.storage?.local ?? null;

const read = async (store, key, fallback) => {
  try {
    return (await store?.get(key))?.[key] ?? fallback;
  } catch {
    return fallback;
  }
};

/**
 * Register content.js for the sites page tools are allowed on — and only for
 * those.
 *
 * Called at every start (a registration does survive a worker restart, but a
 * profile that has lost it is cheaper to fix than to diagnose), and again
 * whenever the site list or the granted permissions change. The two have to
 * agree: a pattern in the list without the permission behind it is refused by
 * `registerContentScripts`, which would take the whole registration down with
 * it, so what is granted is what is registered.
 */
async function syncPageTools() {
  if (!api.scripting?.registerContentScripts) return;

  const wanted = await read(local, SITES_KEY, []);
  const allowed = [];
  for (const pattern of wanted) {
    try {
      if (await api.permissions.contains({ origins: [pattern] })) allowed.push(pattern);
    } catch {
      /* a pattern the browser will not even consider; leave it out */
    }
  }

  try {
    const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
    if (existing.length) await api.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
  } catch {
    /* nothing registered, which is the state the next lines want anyway */
  }
  if (!allowed.length) return;

  try {
    await api.scripting.registerContentScripts([{
      id: SCRIPT_ID,
      js: ['content.js'],
      matches: allowed,
      // An editor's field is as often in an iframe as in the page itself, and
      // a selection belongs to one frame either way — so every frame gets the
      // script and the frame that owns the thing is the one that reacts.
      allFrames: true,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  } catch {
    return;   // nothing registered; the app's settings screen says page tools are off
  }

  /* A registration only reaches pages loaded after it, which would mean
     allowing a site and then having to reload the tab you allowed it for.
     Injecting into what is already open closes that gap; content.js guards
     against running twice in one frame, so a frame that raced the two and got
     both is no worse off than one that got either. */
  try {
    for (const tab of await api.tabs.query({ url: allowed })) {
      if (tab.id === undefined) continue;
      api.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      }).catch(() => { /* a frame that refuses injection, or already has it */ });
    }
  } catch {
    /* no tabs to look at */
  }
}

syncPageTools();
api.permissions.onAdded?.addListener(syncPageTools);
api.permissions.onRemoved?.addListener(syncPageTools);
api.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && SITES_KEY in changes) syncPageTools();
});

/**
 * Open the app, wherever this browser keeps it.
 *
 * The same three-way split as the toolbar click above, and for the same
 * reasons — with one extra constraint: both panel APIs require a user gesture,
 * and the gesture here is the click in the page that sent us this message. It
 * survives exactly as long as nothing is awaited before the call, which is why
 * this runs before the request is queued rather than after.
 */
function openApp(tabId) {
  if (api.sidePanel?.open) {
    return api.sidePanel.open(tabId === undefined ? {} : { tabId })
      .catch(() => openTab());
  }
  if (api.sidebarAction?.open) {
    return api.sidebarAction.open().catch(() => openTab());
  }
  return openTab();
}

async function openTab() {
  if (await focusExisting()) return;
  const tab = await api.tabs.create({ url: api.runtime.getURL('index.html') });
  openTabId = tab.id;
}

/**
 * One request from a page, on its way to the app.
 *
 * The tab and frame it came from travel with it, because a write has to go
 * back to the very field it was asked about — and "the active tab" is not
 * that: by the time the model has written anything the person may well be
 * reading something else.
 */
async function queue(request, sender) {
  const pending = await read(session, QUEUE_KEY, []);
  pending.push({
    ...request,
    tabId: sender.tab?.id ?? null,
    frameId: sender.frameId ?? 0,
    at: Date.now(),
  });
  // A bound, so a panel that never opens cannot let this grow without end.
  try { await session?.set({ [QUEUE_KEY]: pending.slice(-8) }); } catch { /* nothing to queue into */ }
  // For a panel that is already open and will never boot again. Nothing is
  // sent with it: the app claims the queue, which is what keeps one request
  // from being acted on twice.
  api.runtime.sendMessage({ type: 'ivx:page-nudge' }).catch(() => { /* nobody listening yet */ });
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    /* From a page: act on this. The panel opens first, synchronously, while
       the click that asked for it still counts as a gesture. */
    case 'ivx:page-action': {
      const { type, ...request } = message;
      openApp(sender.tab?.id);
      queue(request, sender).then(() => sendResponse({ ok: true }));
      return true;
    }

    /* From the app, at boot and at every nudge: what has come in. Claimed, not
       read — whoever asks takes it, and a second asker gets nothing. */
    case 'ivx:page-pending': {
      read(session, QUEUE_KEY, [])
        .then(async pending => {
          try { await session?.remove(QUEUE_KEY); } catch { /* already gone */ }
          sendResponse({ pending });
        });
      return true;
    }

    /* From the app: put this in that field, in the frame that offered it. */
    case 'ivx:page-write': {
      if (message.tabId === null || message.tabId === undefined) {
        sendResponse({ ok: false, error: 'The page this was asked from is gone.' });
        return false;
      }
      api.tabs.sendMessage(message.tabId, {
        type: 'ivx:page-write',
        fieldId: message.fieldId,
        text: message.text,
        mode: message.mode,
      }, { frameId: message.frameId ?? 0 })
        .then(result => sendResponse(result || { ok: false, error: 'The page did not answer.' }))
        .catch(() => sendResponse({
          ok: false,
          error: 'That page is no longer listening — it may have been closed or reloaded.',
        }));
      return true;
    }

    /* From the app whenever its agents change, or whenever the chat on screen
       moves to a different one: the names content.js offers in its picker, and
       which of them that picker should open on. Only names and ids — nothing
       about a provider, a model or a key is ever put where a page could reach
       it. */
    case 'ivx:agents': {
      const agents = (message.agents || [])
        .map(a => ({ id: String(a.id), name: String(a.name) }))
        .slice(0, 100);
      const active = message.active ? String(message.active) : null;
      (local?.set({ [AGENTS_KEY]: { agents, active } }) ?? Promise.resolve())
        .catch(() => { /* nothing to store into; the picker falls back */ })
        .then(() => sendResponse({ ok: true }));
      return true;
    }

    /* From a page: who can be asked, and who is answering right now. */
    case 'ivx:page-agents': {
      read(local, AGENTS_KEY, {}).then(held => sendResponse({
        agents: held?.agents || [],
        active: held?.active ?? null,
      }));
      return true;
    }

    default:
      return false;
  }
});

/* ── reading a page ────────────────────────────────────────────

   Three things the app cannot do for itself, because an extension page has no
   reach into a tab: list what is open, read a page's markup, and photograph
   one. All three are bounded by the same list as everything else here — the
   sites page tools was allowed on — so a tab the person has not allowed is not
   listed, not read and not captured. A grant made for a *provider* endpoint
   does not widen this: `allowedUrl` checks the page-tools list specifically,
   not whatever the browser happens to have granted.

   The app asks for a page only when the person has mentioned its tab with `@`.
   That is the app's rule rather than this one's, and it is enforced there; what
   is enforced here is the permission, which is the part a page cannot argue
   with. */

/** How much markup is worth sending back. Past this the model is reading
    boilerplate, and the cut is reported rather than made quietly. */
const SNAPSHOT_LIMIT = 60000;

/**
 * Is this address one page tools may touch?
 *
 * Compared against the patterns as they are written, which is safe because
 * they are only ever written one way — `patternFor` in web/src/host-access.js
 * builds `scheme://hostname/*` and nothing else, and `<all_urls>` is the one
 * special case. A matcher that tried to be general would be a wildcard parser
 * standing between a page and a permission, which is not a thing worth
 * writing twice.
 */
function allowedUrl(url, patterns) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!/^https?:$/.test(parsed.protocol)) return false;
  return patterns.some(p => p === '<all_urls>' || p === `${parsed.protocol}//${parsed.hostname}/*`);
}

/** The open tabs the person may mention, newest window first as the browser
    reports them. A tab with no `url` is one we have no permission for — the
    browser withholds it rather than erroring — and is left out either way. */
async function listTabs() {
  const patterns = await read(local, SITES_KEY, []);
  if (!patterns.length) return [];
  let tabs = [];
  try {
    tabs = await api.tabs.query({});
  } catch {
    return [];
  }
  return tabs
    .filter(tab => tab.id !== undefined && tab.url && allowedUrl(tab.url, patterns))
    .map(tab => ({
      tabId: tab.id,
      windowId: tab.windowId ?? null,
      title: tab.title || '',
      url: tab.url,
      host: (() => {
        try { return new URL(tab.url).hostname; } catch { return ''; }
      })(),
    }))
    .slice(0, 50);
}

/**
 * The page's markup, with everything that is not the page taken out.
 *
 * Injected rather than asked of content.js: `executeScript` reaches a tab
 * whether or not the content script happens to be in it, which matters because
 * the registration only catches pages loaded after it. Same permission either
 * way — this runs nowhere `allowedUrl` has not already agreed to.
 *
 * Declared as a plain function with no free variables because it is serialized
 * and run in another page; nothing it closes over would travel with it.
 */
function collectSnapshot(selector, limit) {
  const root = (selector && document.querySelector(selector)) || document.documentElement;
  if (!root) return { error: `Nothing on the page matches ${selector}.` };

  const copy = root.cloneNode(true);
  /* Script and style are not content; link and meta are not either. An iframe
     is another document that this cannot reach into, and canvas and svg are
     pictures — a screenshot is the tool for those. */
  for (const node of copy.querySelectorAll(
    'script, style, noscript, template, link, meta, svg, canvas, iframe, object, embed')) {
    node.remove();
  }
  /* Attributes that are plumbing rather than meaning. Handlers and inline
     styles are noise; a framework's data-* bookkeeping can be most of the
     bytes on the page. id and class stay — they are how the model names a
     part of the page back to us. */
  for (const node of copy.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || name === 'style' || name.startsWith('data-')) {
        node.removeAttribute(attr.name);
      }
    }
  }

  const html = copy.outerHTML
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();

  return {
    title: document.title,
    url: location.href,
    html: html.slice(0, limit),
    truncated: html.length > limit,
  };
}

/**
 * A picture of the tab.
 *
 * Firefox can photograph a tab that is not in front. Chrome and Safari cannot
 * — `captureVisibleTab` means what it says — so the tab is brought forward,
 * caught, and put back where it was. Bringing someone's tab forward is rude
 * enough that it is worth doing only for as long as the shutter takes, hence
 * the restore in `finally`.
 */
async function captureTab(tabId) {
  const tab = await api.tabs.get(tabId);
  if (api.tabs.captureTab) return api.tabs.captureTab(tabId, { format: 'png' });

  const [front] = await api.tabs.query({ active: true, windowId: tab.windowId });
  const restore = front && front.id !== tabId ? front.id : null;
  if (restore) {
    await api.tabs.update(tabId, { active: true });
    // A tab that has just been shown has not necessarily been painted, and an
    // unpainted tab photographs as the one before it.
    await new Promise(done => setTimeout(done, 250));
  }
  try {
    return await api.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } finally {
    if (restore) api.tabs.update(restore, { active: true }).catch(() => { /* window gone */ });
  }
}

/** Everything above, behind one permission check, so no caller can reach a
    tab by handing us an id the person never allowed. */
async function onAllowedTab(tabId, work) {
  const patterns = await read(local, SITES_KEY, []);
  let tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    return { ok: false, error: 'That tab is no longer open.' };
  }
  if (!tab.url || !allowedUrl(tab.url, patterns)) {
    return { ok: false, error: 'Page tools are not allowed on that tab.' };
  }
  try {
    return await work(tab);
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    /* From the app, when someone types `@`: what is open and mentionable. */
    case 'ivx:tabs': {
      listTabs().then(tabs => sendResponse({ tabs }));
      return true;
    }

    /* From the app, for a `<snapshot>` call on a mentioned tab. */
    case 'ivx:page-snapshot': {
      onAllowedTab(message.tabId, async () => {
        const [hit] = await api.scripting.executeScript({
          target: { tabId: message.tabId },
          func: collectSnapshot,
          args: [message.selector || '', SNAPSHOT_LIMIT],
        });
        const result = hit?.result;
        if (!result) return { ok: false, error: 'The page returned nothing.' };
        if (result.error) return { ok: false, error: result.error };
        return { ok: true, ...result };
      }).then(sendResponse);
      return true;
    }

    /* From the app, for a `<screenshot>` call. Comes back as a data URL, which
       the app turns into an ordinary attachment on the tool's own message. */
    case 'ivx:page-screenshot': {
      onAllowedTab(message.tabId, async tab => {
        const dataUrl = await captureTab(message.tabId);
        if (!dataUrl) return { ok: false, error: 'The browser returned no image.' };
        return { ok: true, dataUrl, title: tab.title || '', url: tab.url };
      }).then(sendResponse);
      return true;
    }

    default:
      return false;
  }
});
