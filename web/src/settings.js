// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Settings, as a stack of screens on the bottom sheet.

   Each screen shows one group of related things; anything deeper is a row you
   tap. Fields save on change — there is no Save button to forget. */

import * as store from './store.js';
import * as vault from './vault.js';
import * as api from './providers.js';
import * as bridge from './bridge.js';
import * as access from './host-access.js';
import * as mcp from './mcp.js';
import * as pageTools from './page-tools.js';
import * as registry from './registry.js';
import * as market from './market.js';
import * as usage from './usage.js';
import * as attach from './attach.js';
import { parseConfig } from './mcp-config.js';
import {
  el, toast, openSheet, pushScreen, popScreen, closeSheet, refreshSheet, entityScreen,
  confirmAction, promptText, chooseFromList, askScreen, downloadJSON, searchBar,
} from './ui.js';

let app;                                   // the chat shell's own API

/** The shell is wired once at boot, so agent screens reachable from the chat
    (not just through Settings) can call back into the app. */
export function setShell(shell) { app = shell; }

export function openSettings(shell) {
  app = shell;
  openSheet({ title: 'Settings', render: rootScreen });
}

/** Opens the sheet straight on the Providers screen — for entry points
    outside Settings that already know where they are headed. */
export function openProviders(shell) {
  openSettings(shell);
  pushScreen({ title: 'Providers', render: providersScreen });
}

/* ── building blocks ───────────────────────────────────────── */

const group = (label, rows, note) => el('div', { class: 'group' }, [
  label ? el('div', { class: 'group-label', text: label }) : null,
  el('div', { class: 'item-list' }, rows.filter(Boolean)),
  note ? el('div', { class: 'group-note', text: note }) : null,
]);

const navRow = (title, { sub, value, onclick, tag, dot, danger } = {}) => el('button', {
  class: `item${danger ? ' danger' : ''}`, type: 'button', onclick,
}, [
  dot !== undefined ? el('span', { class: `dot${dot ? ' on' : ''}` }) : null,
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
  tag ? el('span', { class: 'tag', text: tag }) : null,
  value ? el('span', { class: 'item-value', text: value }) : null,
  el('span', { class: 'item-chevron', text: '›' }),
]);

const actionRow = (title, { onclick, danger, sub } = {}) => el('button', {
  class: `item${danger ? ' danger' : ''}`, type: 'button', onclick,
}, [
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
]);

const linkRow = (title, href, sub) => el('a', {
  class: 'item', href, target: '_blank', rel: 'noopener noreferrer',
}, [
  el('span', { class: 'item-main' }, [
    el('span', { class: 'item-title', text: title }),
    sub ? el('span', { class: 'item-sub', text: sub }) : null,
  ]),
  el('span', { class: 'item-chevron', text: '↗' }),
]);

const switchRow = (label, checked, onchange) => el('div', { class: 'item' }, [
  el('label', { class: 'form-check form-switch w-100' }, [
    el('span', { class: 'form-check-label', text: label }),
    el('input', { class: 'form-check-input', type: 'checkbox', checked, onchange: ev => onchange(ev.target.checked) }),
  ]),
]);

const field = (label, control, note) => el('div', { class: 'field' }, [
  el('label', { class: 'field-label', text: label }),
  control,
  note ? el('div', { class: 'field-note', text: note }) : null,
]);

/* ── disclaimer ────────────────────────────────────────────── */

/* The footer has room for one line, and this does not fit in one line. So the
   footer carries the short version and this carries the whole of it, broken
   into the four things it actually says. */
export function openDisclaimer() {
  openSheet({ title: 'Disclaimer', render: disclaimerScreen });
}

function disclaimerScreen() {
  const point = (title, body) => el('div', { class: 'intro-point' }, [
    el('div', { class: 'intro-title', text: title }),
    el('p', { class: 'intro-body', text: body }),
  ]);

  return el('div', {}, [
    el('div', { class: 'intro' }, [
      point('AI may be wrong',
        'AI may generate inaccurate or false information.'),
      point('We do not provide the models',
        'This tool is a chat interface only; we do not provide the AI models.'),
      point('Your data never reaches us',
        'Your data is never stored or processed by us. This interface runs ' +
        'entirely in your browser and connects directly to your specified CORS ' +
        'proxy. Chat processing is handled by the server hosting your chosen model.'),
      point('Prefer self-hosted models',
        'We do not endorse closed-source models and recommend using self-hosted ' +
        'models whenever possible.'),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-block', type: 'button', text: 'Got it',
        onclick: () => closeSheet(),
      }),
    ]),
  ]);
}

/* ── first run ─────────────────────────────────────────────── */

export function openIntro(shell) {
  if (shell) app = shell;
  openSheet({ title: 'Welcome to ivx/ai Chat ✨', render: introScreen });
}

function introScreen() {
  const point = (title, body) => el('div', { class: 'intro-point' }, [
    el('div', { class: 'intro-title', text: title }),
    el('p', { class: 'intro-body', text: body }),
  ]);

  return el('div', {}, [
    el('div', { class: 'intro' }, [
      point('A UI for your LLM API',
        'Bring a key from any provider, point it at a model on your own machine, ' +
        'or run a model right inside this browser. This is the interface — you ' +
        'choose the engine.'),
      point('Private and local first',
        'WebLLM needs no setup at all: the model is downloaded into this browser ' +
        'and answered here. Ollama, LM Studio, llama.cpp and friends are ' +
        'first-class too, and a scan finds the ones already running. Hosted ' +
        'providers work as well; the choice and the key stay yours.'),
      point('Lightweight, and it runs anywhere',
        'One page in a browser. No backend, no accounts, no analytics and zero ' +
        'telemetry. Your chats and keys are stored here and shipped nowhere.'),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-block', type: 'button', text: 'Get started',
        onclick: () => closeSheet(),
      }),
      el('button', {
        class: 'btn btn-secondary btn-block', type: 'button', text: 'Set up a provider',
        onclick: () => openProviders(app),
      }),
    ]),
  ]);
}

/* ── root ──────────────────────────────────────────────────── */

function rootScreen() {
  const providers = app.getProviders();
  const local = providers.filter(p => api.isLocalUrl(p.baseUrl)).length;
  const { encrypted, unlocked } = vault.status();

  return el('div', {}, [
    group(null, [
      navRow('Agents', {
        sub: app.getAgents().length ? `${app.getAgents().length} configured` : 'None yet — one is made per provider',
        onclick: () => pushScreen(app.agentScreens.picker()),
      }),
      navRow('Providers', {
        sub: providers.length
          ? `${providers.length} configured · ${local} local`
          : 'None yet — add one to start',
        onclick: () => pushScreen({ title: 'Providers', render: providersScreen }),
      }),
      navRow('MCP servers', {
        sub: app.getMcpServers().length
          ? `${app.getMcpServers().length} configured`
          : 'None — tools an agent can call',
        onclick: () => pushScreen({ title: 'MCP servers', render: mcpScreen }),
      }),
      navRow('Store', {
        sub: storeSourcesLine(),
        onclick: () => pushScreen({ title: 'Store', render: storeScreen }),
      }),
      pageTools.AVAILABLE ? navRow('Page tools', {
        sub: pageToolsLine(),
        dot: pageTools.sites().length > 0,
        onclick: () => pushScreen({ title: 'Page tools', render: pageToolsScreen }),
      }) : null,
      navRow('Sharing', {
        sub: app.getUI().shareBaseUrl
          ? String(app.getUI().shareBaseUrl).trim().replace(/\/+$/, '')
          : bridge.EXTENSION
            ? 'Links open at ai.ivx.run/chat'
            : 'Links open where the app is served',
        onclick: () => pushScreen({ title: 'Sharing', render: sharingScreen }),
      }),
      navRow('CORS bypass', {
        sub: bridge.describe(),
        dot: bridge.unrestricted(),
        onclick: () => pushScreen({ title: 'CORS bypass', render: corsBypassScreen }),
      }),
      navRow('Appearance', {
        sub: `${app.getUI().theme} theme`,
        onclick: () => pushScreen({ title: 'Appearance', render: appearanceScreen }),
      }),
      navRow('Privacy & data', {
        sub: encrypted ? (unlocked ? 'Keys encrypted, unlocked' : 'Keys encrypted, locked') : 'Keys stored in the clear',
        onclick: () => pushScreen({ title: 'Privacy & data', render: privacyScreen }),
      }),
      navRow('About', { onclick: () => pushScreen({ title: 'About', render: aboutScreen }) }),
    ]),
  ]);
}

/* ── providers ─────────────────────────────────────────────── */

function providersScreen() {
  const providers = app.getProviders();

  return el('div', {}, [
    group('On this machine', [
      actionRow('Scan for local servers', {
        sub: 'Ollama, LM Studio, llama.cpp, Jan, vLLM…',
        onclick: scanLocal,
      }),
      access.MANAGED && !access.granted(api.LOCAL_CANDIDATES.map(c => c.host))
        ? actionRow('Allow this machine', {
            sub: 'So the scan can reach a runtime that refuses browser origins',
            // Straight out of the click: asking after an await loses the
            // gesture the browser requires.
            onclick: () => access.request(api.LOCAL_CANDIDATES.map(c => c.host))
              .then(ok => {
                toast(ok ? 'Allowed — scan now' : 'Not allowed; the scan will only find CORS-friendly runtimes',
                  ok ? 'ok' : 'err');
                refreshSheet();
              }),
          })
        : null,
    ], bridge.EXTENSION
      ? (access.granted(api.LOCAL_CANDIDATES.map(c => c.host))
          ? 'Probed directly, with no Origin attached, so a runtime that refuses ' +
            'browser origins still shows up.'
          : 'Until this machine is allowed above, the scan only finds runtimes ' +
            'that answer browser origins.')
      : bridge.ready()
        ? 'Probed through the bridge, so a runtime that refuses browser origins still shows up.'
        : 'A runtime that refuses browser origins will not answer. Settings → CORS bypass fixes that.'),

    group('Configured', providers.length
      ? providers.map(p => navRow(p.name, {
          sub: p.kind === 'webllm' ? 'Runs in this browser' : (p.baseUrl || 'No address set'),
          dot: Boolean(p.models?.length),
          tag: access.MANAGED && p.baseUrl && !access.granted(p.baseUrl)
            ? 'not allowed'
            : (api.isLocalUrl(p.baseUrl) ? 'local' : null),
          onclick: () => pushScreen(providerScreen(p.id)),
        }))
      : [actionRow('No providers yet', {})]),

    group(null, [
      actionRow('Add a provider', { onclick: addProvider }),
    ]),
  ]);
}

/* ── page tools ────────────────────────────────────────────── */

/* Selecting text on a page offers to summarize it, translate it or put a
   question about it to an agent; focusing a text field offers to write into
   it. None of that runs anywhere until a site is named here.

   Which is the whole screen, really. The extension asks for nothing on
   install, and what it can reach afterwards is this list — one host at a time,
   granted by the browser's own prompt on the click that names it, and given
   back the moment the row goes. See web/src/page-tools.js and the note in
   packaging/extension/background.js for what happens in between. */

/** A match pattern as a person would say it. */
const siteName = pattern => (pattern === pageTools.EVERY_SITE
  ? 'Every site'
  : pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, ''));

function pageToolsLine() {
  const allowed = pageTools.sites();
  if (!allowed.length) return 'Off — no sites allowed';
  if (allowed.includes(pageTools.EVERY_SITE)) return 'On for every site';
  return allowed.length === 1 ? `On for ${siteName(allowed[0])}` : `On for ${allowed.length} sites`;
}

function pageToolsScreen() {
  const allowed = pageTools.sites();
  const everywhere = allowed.includes(pageTools.EVERY_SITE);

  const lang = el('input', {
    class: 'form-control', type: 'text', value: app.getUI().pageToolsLang || '',
    placeholder: pageTools.defaultLanguage(), spellcheck: 'false',
    onchange: ev => {
      app.setUI({ pageToolsLang: ev.target.value.trim() });
      refreshSheet();
    },
  });

  return el('div', {}, [
    group('Runs on', [
      ...allowed.map(pattern => actionRow(siteName(pattern), {
        sub: 'Tap to stop running here',
        onclick: () => pageTools.forget(pattern).then(refreshSheet),
      })),
      !allowed.length ? actionRow('No sites yet', {}) : null,
      !everywhere ? actionRow('Allow a site…', {
        sub: 'One host, and every page on it',
        onclick: () => pushScreen({ title: 'Allow a site', render: allowSiteScreen }),
      }) : null,
      !everywhere ? actionRow('Allow every site', {
        sub: 'The browser will say what that means before you agree',
        // Straight out of the click, with nothing awaited first: the
        // permission prompt needs the gesture, and an await loses it.
        onclick: () => pageTools.allow(pageTools.EVERY_SITE).then(ok => {
          toast(ok ? 'Page tools are on everywhere' : 'Not allowed', ok ? 'ok' : 'err');
          refreshSheet();
        }),
      }) : null,
    ], allowed.length
      ? 'The bar appears on these sites and nowhere else. Removing a site gives ' +
        'the permission back to the browser.'
      : 'Page tools are off. Until a site is allowed, this extension cannot see ' +
        'any page you visit — and that is what the browser told you on install.'),

    group('Translate into', [
      el('div', { class: 'item' }, [
        el('div', { class: 'field w-100' }, [lang]),
      ]),
    ], 'What the Translate button asks for. Any language, written however you ' +
       'would write it to a person; empty follows this browser.'),
  ]);
}

/** Typing the host and allowing it are one screen, because they have to be
    one click: the browser's permission prompt needs the gesture, and a prompt
    for the host first would have spent it. */
function allowSiteScreen() {
  const host = el('input', {
    class: 'form-control', type: 'text', placeholder: 'example.com',
    spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off',
  });

  const allow = () => {
    const pattern = pageTools.patternFor(host.value);
    if (!pattern) { toast('That is not a site address', 'err'); return; }
    pageTools.allow(pattern).then(ok => {
      toast(ok ? `Page tools are on for ${siteName(pattern)}` : 'Not allowed',
        ok ? 'ok' : 'err');
      if (ok) popScreen();
      else refreshSheet();
    });
  };

  return el('div', {}, [
    group(null, [
      el('div', { class: 'item' }, [el('div', { class: 'field w-100' }, [host])]),
    ], 'A host covers every page and every port on it — a browser permission ' +
       'cannot be narrower than that.'),
    el('div', { class: 'sheet-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-block', type: 'button', text: 'Allow this site',
        onclick: allow,
      }),
    ]),
  ]);
}

/* ── sharing ───────────────────────────────────────────────── */

/** Where share links open. When the app runs on this machine, links built
    from this page's own address are dead on arrival elsewhere, so the user
    points them at the public place the app is hosted. */
function sharingScreen() {
  const input = el('input', {
    class: 'form-control', type: 'url', value: app.getUI().shareBaseUrl || '',
    placeholder: `${location.origin}${location.pathname}`,
    spellcheck: 'false', autocapitalize: 'off',
    onchange: async ev => {
      const value = ev.target.value.trim().replace(/\/+$/, '');
      if (value && !/^https?:\/\//i.test(value)) {
        toast('Starts with http:// or https://', 'err');
        return;
      }
      app.setUI({ shareBaseUrl: value });
      if (value && api.isLocalUrl(value)) {
        toast('Saved — but that is a local address; links built from it open only on this machine', 'err', 9000);
      } else {
        toast('Share links will open at this address', 'ok');
      }
      refreshSheet();
    },
  });

  return el('div', {}, [
    group('Base URL', [
      el('div', { class: 'item' }, [field('Share links open at', input,
        'Leave empty to use the address this app is served from.')]),
    ], 'The chat rides inside the link, but the part before the # decides ' +
       'where it opens. When this app runs on this machine, point this at the ' +
       'public place the same app is hosted — a link built on localhost is ' +
       'unreadable for whoever receives it.'),
  ]);
}

async function scanLocal() {
  const busy = toast('Looking on the usual ports…', '', 20000);
  let hits = [];
  try {
    hits = await api.scanLocal();
  } catch (err) {
    busy.remove();
    toast(err.message, 'err');
    return;
  }
  busy.remove();

  if (!hits.length) {
    toast('Nothing answered. Either no local server is running, or it refuses browser origins.', 'err', 9000);
    return;
  }

  const providers = app.getProviders();
  const added = [];
  for (const hit of hits) {
    const trim = u => u.replace(/\/+$/, '');
    const existing = providers.find(p => trim(p.baseUrl) === trim(hit.baseUrl));
    if (existing) {
      existing.models = hit.models;
      if (!existing.defaultModel && hit.models.length) existing.defaultModel = hit.models[0];
      continue;
    }
    const provider = api.makeProvider(hit.preset);
    provider.baseUrl = hit.baseUrl;
    provider.models = hit.models;
    provider.defaultModel = hit.models[0] || '';
    providers.push(provider);
    added.push(provider);
  }
  await app.saveProviders();
  // Every provider configuration gets a default agent, and it becomes the
  // one new chats reach for.
  for (const p of added) await app.attachDefaultAgent(p);
  refreshSheet();
  toast(added.length ? `Added ${added.length} local provider${added.length === 1 ? '' : 's'}` : 'Already configured — models refreshed', 'ok');
}

async function addProvider() {
  const items = [
    ...api.PRESETS.filter(p => p.local).map(p => ({ value: p.key, label: p.name, sub: p.baseUrl })),
    ...api.PRESETS.filter(p => !p.local).map(p => ({ value: p.key, label: p.name, sub: p.baseUrl || 'Custom address' })),
  ];
  const key = await chooseFromList({ title: 'Add a provider', items });
  if (!key) return;

  const preset = api.PRESETS.find(p => p.key === key);
  const provider = api.makeProvider(preset);
  const providers = app.getProviders();
  if (providers.some(p => p.name === provider.name)) provider.name = `${provider.name} 2`;
  providers.push(provider);
  await app.saveProviders();
  await app.attachDefaultAgent(provider);
  refreshSheet();
  pushScreen(providerScreen(provider.id));
}

/** The provider editor, bound to an id: see `entityScreen`. */
const providerScreen = id => entityScreen({
  find: () => app.getProviders().find(p => p.id === id),
  title: provider => provider.name,
  missing: 'This provider was removed.',
  render: provider => providerBody(provider),
});

function providerBody(provider) {
  const preset = api.PRESETS.find(p => p.key === provider.preset);
  const { encrypted, unlocked } = vault.status();
  const locked = encrypted && !unlocked;
  const kindLabel = api.KINDS.find(k => k.value === provider.kind)?.label || provider.kind;

  const save = async () => { await app.saveProviders(); app.refreshChrome(); };

  const nameInput = el('input', {
    class: 'form-control', type: 'text', value: provider.name, placeholder: 'Name',
    onchange: async ev => {
      provider.name = ev.target.value.trim() || 'Provider';
      await save();
      refreshSheet();
    },
  });

  const urlInput = el('input', {
    class: 'form-control', type: 'url', value: provider.baseUrl, placeholder: 'http://localhost:11434',
    spellcheck: 'false', autocapitalize: 'off',
    onchange: async ev => {
      provider.baseUrl = ev.target.value.trim();
      provider.models = [];
      await save();
      refreshSheet();
    },
  });

  const keyInput = el('input', {
    class: 'form-control', type: 'password', autocomplete: 'off',
    value: locked ? '' : vault.getKey(provider.id),
    placeholder: locked ? 'Locked' : (preset?.needsKey === false ? 'Not required' : 'Paste your key'),
    disabled: locked,
    onchange: async ev => {
      try {
        await vault.setKey(provider.id, ev.target.value.trim());
        toast('Key saved to this browser', 'ok');
      } catch (err) { toast(err.message, 'err'); }
    },
  });

  return el('div', {}, [
    group(null, [
      el('div', { class: 'item' }, [field('Name', nameInput)]),
      navRow('API style', {
        value: kindLabel,
        onclick: async () => {
          const kind = await chooseFromList({
            title: 'API style',
            items: api.KINDS.map(k => ({ value: k.value, label: k.label })),
            selected: provider.kind,
          });
          if (!kind) return;
          provider.kind = kind;
          provider.models = [];
          await save();
          refreshSheet();
        },
      }),
      // WebLLM has neither an address nor a key: the model runs right here.
      ...(provider.kind === 'webllm' ? [] : [
        el('div', { class: 'item' }, [field('Address', urlInput)]),
        accessRow(provider),
        el('div', { class: 'item' }, [field('API key', keyInput,
          locked ? 'Unlock under Privacy & data to edit.' : 'Stored in this browser only.')]),
      ]),
    ]),

    group('Model', [
      navRow('Default model', {
        sub: provider.defaultModel || 'Not set',
        onclick: () => pickModelFor(provider),
      }),
      actionRow(provider.models?.length ? `Refresh models (${provider.models.length} cached)` : 'Fetch models', {
        onclick: async () => { await fetchModels(provider); refreshSheet(); },
      }),
    ], preset?.hint),

    group(null, [
      actionRow('Remove provider', {
        danger: true,
        onclick: async () => {
          const ok = await confirmAction({
            title: `Remove ${provider.name}?`,
            body: 'Its API key is deleted too. Chats that used it are kept.',
            okText: 'Remove',
          });
          if (!ok) return;
          const providers = app.getProviders();
          const i = providers.indexOf(provider);
          if (i >= 0) providers.splice(i, 1);
          // The host it was allowed to reach, unless something else still
          // needs it — one grant can cover two providers on one machine.
          const pattern = access.patternFor(provider.baseUrl);
          if (pattern && !providers.some(p => access.patternFor(p.baseUrl) === pattern)) {
            await access.drop(provider.baseUrl);
          }
          try { await vault.removeKey(provider.id); } catch { /* locked: stays encrypted */ }
          await save();
          // Its agents would point at a provider that no longer exists.
          await app.forgetProvider(provider);
          popScreen();
          refreshSheet();
        },
      }),
    ]),
  ]);
}

/**
 * Permission to call this endpoint, where the browser makes that a question.
 *
 * Absent from the hosted build and from the desktop app, where it is not one.
 * Absent too until there is an address to ask about — the point of asking per
 * host is that there is a host to name, and a blank field names nothing.
 *
 * Worth saying on the page even once it is granted. The grant covers every
 * port on that host, which is more than the address on screen suggests, and
 * someone who wants to know what this extension may reach should be able to
 * read it here rather than in the browser's own settings.
 */
function accessRow(provider) {
  if (!access.MANAGED || !provider.baseUrl) return null;
  const host = access.hostOf(provider.baseUrl);
  if (!access.patternFor(provider.baseUrl)) return null;

  if (access.granted(provider.baseUrl)) {
    return actionRow(`Allowed to reach ${host}`, {
      sub: 'Any port on that host — the browser grants no finer',
    });
  }
  return actionRow(`Allow access to ${host}`, {
    // Called straight out of the click. An await before `request` loses the
    // user gesture the browser insists on, and the prompt never appears.
    onclick: () => access.request(provider.baseUrl).then(ok => {
      if (ok) toast(`This extension may now call ${host}`, 'ok');
      else toast('Not allowed — the endpoint has to answer browser origins, or go via the bridge', 'err', 9000);
      refreshSheet();
    }),
    sub: 'Needed only if this endpoint refuses browser origins',
  });
}

/** Returns true when the list came back; false is a normal outcome here. */
async function fetchModels(provider) {
  const busy = toast(`Asking ${provider.name}…`, '', 20000);
  try {
    provider.models = await api.listModels(provider, vault.getKey(provider.id));
    if (!provider.defaultModel && provider.models.length) provider.defaultModel = provider.models[0];
    await app.saveProviders();
    app.refreshChrome();
    busy.remove();
    toast(provider.models.length
      ? `${provider.models.length} models available`
      : 'That endpoint listed no models — type the name instead', provider.models.length ? 'ok' : 'err');
    return provider.models.length > 0;
  } catch (err) {
    busy.remove();
    toast(`${err.message} — you can still type the model name`, 'err', 9000);
    return false;
  }
}

/**
 * Pick a model for a provider. Manual entry is always offered: plenty of
 * endpoints have no /models route at all (Azure deployments, bare llama.cpp
 * builds, private proxies) or refuse to list one without a key.
 */
export function chooseModel(provider, selected, title = 'Model') {
  return askScreen(title, done => {
    const models = api.knownModels(provider);

    const typeItIn = async () => {
      const name = await promptText({
        title: 'Model name',
        value: selected || '',
        placeholder: provider.kind === 'ollama' ? 'llama3.2' : 'gpt-4o-mini',
        okText: 'Use this model',
      });
      if (!name) return;
      api.rememberModel(provider, name);
      await app.saveProviders();
      done(name);
    };

    const content = el('div', {}, [
      models.length ? el('div', { class: 'group', dataset: { searchGroup: '' } }, [
        el('div', { class: 'item-list' }, models.map(m => el('button', {
          class: `item${m === selected ? ' is-active' : ''}`, type: 'button',
          dataset: { search: m.toLowerCase() },
          onclick: () => done(m),
        }, [
          el('span', { class: 'item-main' }, [el('span', { class: 'item-title', text: m })]),
          el('span', { class: 'item-check', text: m === selected ? '✓' : '' }),
        ]))),
      ]) : null,

      group(null, [
        actionRow('Type a model name', { onclick: typeItIn }),
        actionRow(models.length ? 'Refresh the list' : 'Fetch the model list', {
          sub: provider.kind === 'webllm' ? 'In this browser' : (provider.baseUrl || 'No address set'),
          onclick: async () => { await fetchModels(provider); refreshSheet(); },
        }),
      ], models.length ? null : 'No list yet. Fetch it, or just type the name — ' +
        'some endpoints do not publish one.'),
    ]);

    return el('div', {}, [searchBar(content, { placeholder: 'Search models' }), content]);
  });
}

async function pickModelFor(provider) {
  const previousModel = provider.defaultModel;
  const model = await chooseModel(provider, previousModel, 'Default model');
  if (!model) return;
  provider.defaultModel = model;
  await app.saveProviders();
  // The provider's default agent follows its default model until the agent
  // has a model of its own choosing.
  await app.attachDefaultAgent(provider, previousModel);
  app.refreshChrome();
  refreshSheet();
}

/* ── the Store's sources ───────────────────────────────────── */

/**
 * Where the Store gets its entries.
 *
 * Both of these decide what this app talks to, which is what Settings is for
 * — the Store itself is for browsing. There are two, and they are different
 * in kind: a catalog of JSON entries someone maintains, and the MCP registry,
 * which is an open index run by the protocol's own project. The registry is a
 * switch because turning it on is what starts the fetching.
 */
function storeScreen() {
  const on = registry.isOn();
  const where = registry.host(registry.url());
  const catalog = market.catalogUrl();

  return el('div', {}, [
    group('MCP servers', [
      switchRow(`Use the MCP registry \u00b7 ${where}`, on, async checked => {
        await registry.setOn(checked);
        refreshSheet();
      }),
      on ? switchRow('Show how much each server is used', usage.isOn(), async checked => {
        await usage.setOn(checked);
        refreshSheet();
      }) : null,
      on ? navRow('Registry address', {
        sub: registry.url(),
        onclick: async () => {
          const next = await promptText({
            title: 'Registry address', value: registry.url(), okText: 'Set',
            placeholder: registry.DEFAULT_URL,
          });
          if (next === null) return;
          await registry.setUrl(next);
          refreshSheet();
        },
      }) : null,
    ], on
      ? 'Usage figures come from api.npmjs.org and api.github.com, which learn ' +
        'which entries you open.'
      : `Off: the Store lists no MCP servers. Servers you have already installed ` +
        'keep working either way.'),

    /* The one thing here worth stopping for: the entries are a third party's,
       not ours. Boxed rather than buried in the note above it. */
    on ? el('div', { class: 'group' }, [
      el('div', { class: 'group-note warn', text:
        `Anyone can publish to ${where}, and nobody reviews it. Installing still asks ` +
        'first, and shows what it will run here or where your tool calls go.' }),
    ]) : null,

    group('Catalog', [
      navRow('Catalog address', {
        sub: catalog || 'Not set',
        onclick: async () => {
          const next = await promptText({
            title: 'Catalog address', value: catalog, okText: 'Set',
            placeholder: 'https://raw.githubusercontent.com/you/ai-store/main/',
          });
          if (next === null) return;
          await market.setCatalogUrl(next);
          refreshSheet();
        },
      }),
    ], 'Providers, agents and skills come from a git-hosted catalog of JSON entries \u2014 ' +
      'configuration, never code, fetched while the Store is open and cached for a day. ' +
      'Leave it unset if you do not use one.'),
  ]);
}

/** The one-line summary the Settings list shows for the row above. */
function storeSourcesLine() {
  const bits = [];
  bits.push(registry.isOn() ? 'MCP registry on' : 'MCP registry off');
  if (market.catalogUrl()) bits.push('catalog set');
  return bits.join(' \u00b7 ');
}

/**
 * Opened from the Store as well as from Settings, so the screen that explains
 * the sources is the same screen either way. Pushed, not opened: Back returns
 * to wherever the question came up.
 */
export function openStoreSettings(shell, onDone) {
  if (shell) app = shell;
  pushScreen({ title: 'Store', render: storeScreen, onDismiss: onDone });
}

/* ── MCP servers ───────────────────────────────────────────── */

const MCP_TRANSPORTS = [
  { value: 'http', label: 'Remote', sub: 'An MCP server on the internet, spoken to with fetch' },
  { value: 'stdio', label: 'Local (stdio)', sub: 'A program on this machine, started by the bridge' },
];

/* Last known health per server id: `'checking'`, or what mcp.test() answered.

   A configured server that never answers is otherwise indistinguishable from
   a working one — promptSection() drops it without a word, and the only sign
   is the model saying it has no tools, which is true and useless. So the list
   asks each server on the way in and reports what it found. */
const mcpHealth = new Map();

/** Ask every enabled server whose answer we do not already have. */
async function probeMcp(servers) {
  const todo = servers.filter(s => s.enabled !== false && !mcpHealth.has(s.id));
  if (!todo.length) return;
  for (const s of todo) mcpHealth.set(s.id, 'checking');
  refreshSheet();
  await Promise.all(todo.map(async s => { mcpHealth.set(s.id, await mcp.test(s)); }));
  refreshSheet();
}

/** Forget a server's health so the next look re-asks: its settings changed. */
export function forgetMcpHealth(id) { mcpHealth.delete(id); }

/** What a row says under the server's name. */
function mcpHealthLine(server) {
  const where = server.transport === 'stdio'
    ? `Local · ${server.command || 'no command set'}`
    : (server.url || 'No address set');
  if (server.enabled === false) return `Off · ${where}`;
  const health = mcpHealth.get(server.id);
  if (!health) return where;
  if (health === 'checking') return 'Asking it what it offers…';
  // The server's own sentence when it gave one: "needs sign-in" is the
  // category, and what it actually objected to is the useful half.
  if (health.needsAuth) return `Needs sign-in · ${health.detail || where}`;
  if (!health.ok) return `Not answering · ${health.error}`;
  if (!health.tools.length) return 'Answers, but offers no tools';
  return `${health.tools.length} tool${health.tools.length === 1 ? '' : 's'} · ${where}`;
}

function mcpScreen() {
  const servers = app.getMcpServers();
  probeMcp(servers);

  // What the model will actually be offered, which is the question the list is
  // really being asked.
  const broken = servers.filter(s => {
    const health = mcpHealth.get(s.id);
    return s.enabled !== false && health && health !== 'checking' && !health.ok;
  });
  const localBroken = broken.filter(s => s.transport === 'stdio');

  return el('div', {}, [
    group('Configured', servers.length
      ? servers.map(s => navRow(s.name, {
          sub: mcpHealthLine(s),
          dot: s.enabled !== false && mcpHealth.get(s.id)?.ok !== false,
          tag: s.transport === 'stdio' ? 'local' : null,
          onclick: () => pushScreen(mcpServerScreen(s.id)),
        }))
      : [actionRow('None yet', {})]),

    broken.length ? el('div', { class: 'group' }, [
      el('div', { class: 'group-note warn', text:
        `${broken.map(s => s.name).join(', ')} ${broken.length === 1 ? 'is' : 'are'} not ` +
        'answering, so no tools from ' + (broken.length === 1 ? 'it' : 'them') +
        ' are offered in chats — the model will say it has none.' +
        (localBroken.length && !bridge.supportsMcp()
          ? ' Local servers are started by the bridge, and this app has no bridge that ' +
            'speaks MCP yet — set one up under CORS bypass.'
          : '') }),
    ]) : null,

    group(null, [
      actionRow('Add a server', {
        sub: 'Paste a URL, an install command, or a config',
        onclick: addMcpServer,
      }),
      actionRow('Set one up by hand', { onclick: addMcpServerByHand }),
    ], 'Each server offers its tools to the model in chats where the agent ' +
      'has tools on. Local servers run as programs; they are started by the ' +
      'bridge, so they need it — built into this app, or running separately.'),
  ]);
}

/** The placeholder is the documentation: the three shapes a README hands out,
    so the field answers "what do I put here" before it is asked. */
const MCP_PASTE_PLACEHOLDER = `https://mcp.example.com/mcp

npx add-mcp 'https://mcp.example.com/mcp'

{ "mcpServers": { "filesystem": { "command": "npx", "args": ["-y", "…"] } } }`;

/**
 * Adding by paste.
 *
 * A server is almost never described to a person as "a name, then a
 * transport, then a URL" — it arrives as a line to run or a block of JSON to
 * drop in a config file. So the field takes that, whichever of them it is,
 * and the form is what comes after: the servers land on their own screens
 * with every field already filled in and editable.
 */
async function addMcpServer() {
  const text = await promptText({
    title: 'Add a server', multiline: true, okText: 'Add',
    placeholder: MCP_PASTE_PLACEHOLDER,
  });
  if (!text) return;

  const existing = app.getMcpServers();
  const { servers: parsed, error } = parseConfig(text, { taken: existing.map(s => s.name) });
  if (error) { toast(error, 'err', 9000); return; }

  const saved = await app.saveMcpServers([...existing, ...parsed]);
  const added = saved.slice(-parsed.length);
  // A local server is a program on this machine; say so, rather than letting
  // it look like one more remote address.
  const local = added.filter(s => s.transport === 'stdio');
  if (local.length && !bridge.supportsMcp()) {
    toast(`${local.length === 1 ? local[0].name + ' runs' : 'Some of those run'} on this machine, ` +
      'and need a bridge that speaks MCP — Settings → CORS bypass.', 'err', 9000);
  }

  if (added.length === 1) {
    const [server] = added;
    toast(`Added ${server.name}${server.transport === 'stdio' ? ' as a local server' : ''}`, 'ok');
    pushScreen(mcpServerScreen(server.id));
    return;
  }
  toast(`Added ${added.length} servers: ${added.map(s => s.name).join(', ')}`, 'ok', 7000);
  refreshSheet();
}

/** The long way round, for a server nobody wrote down anywhere. */
async function addMcpServerByHand() {
  const name = await promptText({
    title: 'Name it', value: '', placeholder: 'e.g. DeepWiki', okText: 'Next',
  });
  if (!name) return;
  const transport = await chooseFromList({ title: 'Where does it run?', items: MCP_TRANSPORTS });
  if (!transport) return;
  const servers = app.getMcpServers();
  servers.push({
    id: store.uid(), name, transport, enabled: true,
    viaBridge: transport === 'stdio',
    addedAt: Date.now(),
  });
  const saved = await app.saveMcpServers(servers);
  pushScreen(mcpServerScreen(saved.at(-1).id));
}

/** The MCP server editor, bound to an id: see `entityScreen`. */
const mcpServerScreen = id => entityScreen({
  find: () => app.getMcpServers().find(s => s.id === id),
  title: server => server.name,
  missing: 'This server was removed.',
  render: server => mcpServerBody(server),
});

function mcpServerBody(server) {
  const save = async () => {
    // Whatever was just edited can change whether it answers at all, so the
    // list re-asks rather than showing a verdict from the old settings.
    mcpHealth.delete(server.id);
    await app.saveMcpServers(app.getMcpServers());
  };

  const nameInput = el('input', {
    class: 'form-control', type: 'text', value: server.name, placeholder: 'Name',
    onchange: async ev => {
      server.name = ev.target.value.trim() || server.name;
      ev.target.value = server.name;
      await save();
      refreshSheet();
    },
  });

  const transportLabel = MCP_TRANSPORTS.find(t => t.value === server.transport)?.label
    || server.transport;
  const transportRow = navRow('Transport', {
    value: transportLabel,
    onclick: async () => {
      const next = await chooseFromList({
        title: 'Transport', items: MCP_TRANSPORTS, selected: server.transport,
      });
      if (!next || next === server.transport) return;
      server.transport = next;
      // stdio has no other way to run; a remote server only rides the bridge
      // when asked.
      if (next === 'stdio') server.viaBridge = true;
      await save();
      refreshSheet();
    },
  });

  const urlInput = el('input', {
    class: 'form-control', type: 'url', value: server.url, placeholder: 'https://mcp.example.com/mcp',
    spellcheck: 'false', autocapitalize: 'off',
    onchange: async ev => { server.url = ev.target.value.trim(); await save(); },
  });

  const tokenInput = el('input', {
    class: 'form-control', type: 'password', autocomplete: 'off', value: server.token,
    placeholder: 'Bearer token, if the server wants one',
    onchange: async ev => { server.token = ev.target.value.trim(); await save(); },
  });

  const headersButton = navRow('Extra headers', {
    sub: Object.keys(server.headers || {}).length
      ? `${Object.keys(server.headers).length} set`
      : 'None',
    onclick: async () => {
      const text = await promptText({
        title: 'Extra headers', multiline: true,
        value: JSON.stringify(server.headers || {}, null, 2),
        placeholder: '{ "X-Custom": "value" }',
      });
      if (text === null) return;
      try {
        const parsed = JSON.parse(text || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Not a JSON object');
        server.headers = parsed;
        await save();
        refreshSheet();
      } catch (err) { toast(`Not valid JSON: ${err.message}`, 'err'); }
    },
  });

  const commandInput = el('input', {
    class: 'form-control', type: 'text', value: server.command, placeholder: 'e.g. npx',
    spellcheck: 'false', autocapitalize: 'off',
    onchange: async ev => { server.command = ev.target.value.trim(); await save(); },
  });

  const argsButton = navRow('Arguments', {
    sub: server.args?.length ? server.args.join(' ') : 'None',
    onclick: async () => {
      const text = await promptText({
        title: 'Arguments', multiline: true, okText: 'Save',
        value: (server.args || []).join('\n'),
        placeholder: 'One argument per line, e.g.\n-y\n@modelcontextprotocol/server-filesystem',
      });
      if (text === null) return;
      server.args = text.split('\n').map(l => l.trim()).filter(Boolean);
      await save();
      refreshSheet();
    },
  });

  const envButton = navRow('Environment', {
    sub: Object.keys(server.env || {}).length
      ? `${Object.keys(server.env).length} variables`
      : 'None',
    onclick: async () => {
      const text = await promptText({
        title: 'Environment variables', multiline: true,
        value: JSON.stringify(server.env || {}, null, 2),
        placeholder: '{ "API_KEY": "…" }',
      });
      if (text === null) return;
      try {
        const parsed = JSON.parse(text || '{}');
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            Object.values(parsed).some(v => typeof v !== 'string')) {
          throw new Error('Values must be strings');
        }
        server.env = parsed;
        await save();
        refreshSheet();
      } catch (err) { toast(`Not valid JSON: ${err.message}`, 'err'); }
    },
  });

  const viaBridgeSwitch = switchRow('Route through the CORS bridge', server.viaBridge === true,
    async checked => {
      server.viaBridge = checked;
      await save();
    });

  const testButton = navRow('Test connection', {
    sub: 'Connects and lists the tools it offers',
    onclick: async () => {
      const busy = toast(`Asking ${server.name}…`);
      const result = await mcp.test(server);
      mcpHealth.set(server.id, result);
      busy.remove();
      if (result.ok) {
        toast(result.tools.length
          ? `${server.name}: ${result.tools.join(', ')}`
          : `${server.name} connected but offers no tools`, 'ok', 8000);
      } else {
        toast(`${server.name}: ${result.error}`, 'err', 9000);
      }
    },
  });

  /* Signing in, for a server that wants it.

     Deliberately not hidden behind a "this server uses OAuth" setting: whether
     it does is the server's business and it says so in a 401, so the row is
     always offered and the discovery happens on the click. A server that
     publishes no OAuth metadata says so then, in a sentence, and the bearer
     token field above is still there for one that issues tokens by hand. */
  const health = mcpHealth.get(server.id);
  const isSignedIn = mcp.signedIn(server);

  const signIn = ({ fresh = false } = {}) => {
    /* Straight out of the click, with nothing awaited first. The popup and the
       browser's `identity` permission both need the gesture this click is, and
       the first await inside `connect` is the one that spends it. */
    const running = toast(`Signing in to ${server.name}…`, '', 120000);
    // Whatever it said before was said about the old token.
    mcpHealth.delete(server.id);
    mcp.connect(server, health?.challenge || '', { fresh })
      .then(async () => {
        running.remove();
        toast(`Signed in to ${server.name}`, 'ok');
        mcpHealth.set(server.id, await mcp.test(server));
        refreshSheet();
      })
      .catch(err => {
        running.remove();
        toast(err.message || String(err), 'err', 10000);
        refreshSheet();
      });
  };

  /* Signed in, and refused anyway. Worth its own row: the fix is to go round
     the flow again, and making someone sign out first to reach a sign-in
     button is a step that exists only because we did not offer this one. */
  const reAuthRow = isSignedIn && health?.needsAuth
    ? actionRow('Sign in again', {
        sub: health.detail || 'The server would not accept the last token',
        // From scratch, registration included — see the note in mcp-oauth.js.
        onclick: () => signIn({ fresh: true }),
      })
    : null;

  const signInRow = isSignedIn
    ? actionRow('Sign out', {
        sub: server.oauth?.issuer
          ? `Signed in · ${access.hostOf(server.oauth.issuer)}`
          : 'Signed in',
        onclick: async () => {
          const ok = await confirmAction({
            title: `Sign out of ${server.name}?`,
            body: 'This browser forgets the token and the registration that goes with it. '
              + 'Nothing is revoked at the server — remove the app there too if you want that.',
            okText: 'Sign out',
          });
          if (!ok) return;
          await mcp.disconnect(server);
          mcpHealth.delete(server.id);
          toast('Signed out');
          refreshSheet();
        },
      })
    : actionRow('Sign in', {
        sub: health?.needsAuth
          ? 'This server asked for it'
          : 'For a server that signs you in rather than issuing a token',
        onclick: () => signIn(),
      });

  const isStdio = server.transport === 'stdio';

  return el('div', {}, [
    group(null, [
      el('div', { class: 'item' }, [field('Name', nameInput)]),
      transportRow,
      switchRow('Enabled', server.enabled !== false, async checked => {
        server.enabled = checked;
        await save();
        refreshSheet();
      }),
    ]),

    ...(isStdio ? [
      group('Local server', [
        el('div', { class: 'item' }, [field('Command', commandInput)]),
        argsButton,
        envButton,
      ], isStdio && bridge.supportsMcp()
        ? 'The bridge starts this program on this machine and speaks JSON-RPC to it. '
          + 'Trust the server before you install it: it runs with your user\'s rights.'
        : 'A local server needs a bridge that speaks MCP — update the bridge, or set ' +
          'it up under CORS bypass.'),
    ] : [
      group('Remote server', [
        el('div', { class: 'item' }, [field('URL', urlInput)]),
      ], 'The URL is the server\'s MCP endpoint.'),

      group('Access', [
        reAuthRow,
        signInRow,
        isSignedIn ? null : el('div', { class: 'item' }, [field('Bearer token', tokenInput,
          'For a server that issued you one by hand. Stored in this browser only.')]),
      ], isSignedIn
        ? 'The token is kept with your API keys — encrypted at rest once you set a '
          + 'passphrase under Privacy & data — and is refreshed on its own.'
        : 'Most hosted servers sign you in: a window opens, you approve it there, '
          + 'and the token comes back here. This app registers itself with the server '
          + 'at that moment; there is no account of ours in between.'),

      group('Connection', [
        headersButton,
        viaBridgeSwitch,
      ], 'If the server refuses browser origins with a CORS error, the switch above '
        + 'routes it through the bridge instead.'),
    ]),

    group(null, [testButton]),

    group(null, [
      actionRow('Remove server', {
        danger: true,
        onclick: async () => {
          const ok = await confirmAction({
            title: `Remove ${server.name}?`,
            body: 'Its tools stop being offered to the model. Chats are kept.',
            okText: 'Remove',
          });
          if (!ok) return;
          const servers = app.getMcpServers();
          const i = servers.indexOf(server);
          if (i >= 0) servers.splice(i, 1);
          await save();
          popScreen();
          refreshSheet();
        },
      }),
    ]),
  ]);
}

/* ── CORS bypass ───────────────────────────────────────────── */

const BRIDGE_HELP = 'https://github.com/ivxlabs/ivxai-app#the-bridge';

/**
 * The CORS bridge.
 *
 * Framed as a connection setting rather than a provider one because it is not
 * about any single endpoint: it changes how every provider call leaves this
 * page. The screen therefore has to be honest about that, and about the fact
 * that turning it on means trusting a second program on this machine.
 */
function corsBypassScreen() {
  const s = bridge.status();

  if (s.builtIn) {
    return el('div', {}, [
      group('CORS bridge', [
        actionRow('Built into this app', {
          sub: s.reachable ? `Running on ${s.url}` : 'Not answering — restart the app',
        }),
      ], 'The desktop and mobile app carries its own bridge, so every provider ' +
         'is reachable and there is nothing to set up.'),
    ]);
  }

  const toggle = async on => {
    if (!on) {
      await bridge.disable();
      refreshSheet();
      return;
    }
    try {
      await bridge.enable({ url: s.url || bridge.DEFAULT_URL, token: s.token });
      toast('Bridge on', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
    refreshSheet();
  };

  const rows = [
    switchRow('Use the bridge', s.enabled, toggle),
    navRow('Address', {
      value: s.url || bridge.DEFAULT_URL,
      onclick: async () => {
        const next = await promptText({
          title: 'Bridge address',
          value: s.url || bridge.DEFAULT_URL,
          placeholder: bridge.DEFAULT_URL,
        });
        if (next === null) return;
        const after = await bridge.configure({ url: next.trim() });
        if (after.enabled && !after.ready) toast('Saved, but nothing answered there', 'err');
        refreshSheet();
      },
    }),
    navRow('Token', {
      value: s.token ? 'Set' : 'None',
      sub: 'Only if the bridge was started with --token',
      onclick: async () => {
        const next = await promptText({
          title: 'Bridge token',
          value: s.token,
          placeholder: 'Leave empty for none',
        });
        if (next === null) return;
        await bridge.configure({ token: next.trim() });
        refreshSheet();
      },
    }),
    actionRow('Look for the bridge', {
      sub: 'Checks the usual address on this machine',
      onclick: lookForBridge,
    }),
    s.enabled ? actionRow('Check again', { onclick: recheckBridge }) : null,
  ];

  const stripped = bridge.stripsOrigin();

  return el('div', {}, [
    /* What the extension does and does not settle by itself. Host permissions
       take CORS out of the way, which is most of it — but the call still goes
       out naming this extension in its `Origin`, and an endpoint that vets
       that header refuses it on sight. The extension drops the header to stop
       that; when the drop is not in place, or the endpoint turns the request
       away regardless, the bridge is the way past, so this screen says which
       of those is true right now rather than claiming nothing is needed. */
    bridge.EXTENSION ? group('Provider calls', [
      actionRow(bridge.ready() ? 'Via the bridge' : 'Direct from this extension', {
        sub: bridge.ready()
          ? `Every provider call goes through ${s.url}`
          : 'Straight to the endpoint you configured',
      }),
      actionRow(stripped === false ? 'Sending an Origin header' : 'Origin header dropped', {
        sub: stripped === false
          ? 'Reload this extension on the browser’s extensions page'
          : 'Endpoints see what any program on this machine would send',
      }),
    ], stripped === false
      ? 'This extension is meant to drop its `Origin` header, and right now it ' +
        'is not — so Ollama, LM Studio and anything else that checks that header ' +
        'will answer 403. Reloading the extension puts the rule back. Until then, ' +
        'the bridge reaches those endpoints anyway.'
      : 'For an endpoint you have allowed under Providers, CORS is out of the ' +
        'way and no `Origin` goes out for it to object to. The bridge covers the ' +
        'rest: an endpoint you would rather not grant, one that refuses this ' +
        'machine’s browser whatever it sends, and local MCP servers, which need ' +
        'a program started on this machine.') : null,

    group('CORS bridge', rows, statusNote(s)),

    hostedGroup(s),

    group('What this is', [
      actionRow('Why you might need it', {
        sub: bridge.EXTENSION
          ? 'Endpoints that refuse this extension, and local MCP servers'
          : 'Ollama, llama.cpp and anything else that refuses browser origins',
        onclick: () => pushScreen({ title: 'About the bridge', render: bridgeAboutScreen }),
      }),
      linkRow('Get the bridge', BRIDGE_HELP, 'One small binary, or the full app'),
    ]),
  ]);
}

const API_HELP = 'https://ai.ivx.run/api/';

/**
 * The hosted bridge, for when the one on this machine cannot run.
 *
 * Its own group, with its own switch, because it is a different promise: the
 * bridge above is a program on this computer, and this is ours on the
 * internet. The note under it says that in so many words, every time, rather
 * than once in an about screen nobody opens.
 */
function hostedGroup(s) {
  const h = s.hosted;
  const host = (() => { try { return new URL(h.url).host; } catch { return h.url; } })();

  const askToken = async () => {
    const next = await promptText({
      title: 'ivx/ai token',
      value: h.token,
      placeholder: 'ivx_…',
    });
    return next === null ? null : next.trim();
  };

  const toggle = async on => {
    if (!on) {
      await bridge.disableHosted();
      refreshSheet();
      return;
    }
    let token = h.token;
    if (!token) {
      token = await askToken();
      if (!token) { refreshSheet(); return; }
    }
    try {
      await bridge.enableHosted({ token });
      toast(`Hosted bridge on — ${host}`, 'ok');
    } catch (err) {
      await bridge.configureHosted({ token });
      toast(err.message, 'err');
    }
    refreshSheet();
  };

  const note = !h.enabled
    ? `Off. When it is on and the bridge on this machine is off or not answering, ` +
      `calls to online services go through ${host} instead. Your key and your ` +
      'messages pass through that server on the way. It keeps none of them, but ' +
      'it is a server in the middle, which the bridge on your own machine is not. ' +
      'Endpoints on this machine or network never go that way.'
    : !h.reachable
      ? `Nothing answered at ${h.url}. Is this device online?`
      : h.tokenRefused
        ? `${host} does not recognise that token.`
        : !h.health.originAllowed
          ? `${host} does not accept ${location.origin}.`
          : s.ready
            ? `Standing by. The bridge on this machine is answering, so nothing goes through ${host}.`
            : `On. Calls to online services go through ${host}. Your key and messages ` +
              'pass through it and are not kept. Endpoints on this machine never go that way.';

  return group('Hosted bridge', [
    switchRow(`Fall back to ${host}`, h.enabled, toggle),
    navRow('Token', {
      value: h.token ? 'Set' : 'None',
      sub: 'Your ivx/ai token',
      onclick: async () => {
        const next = await askToken();
        if (next === null) return;
        const after = await bridge.configureHosted({ token: next });
        if (after.hosted.enabled && !after.hosted.ready) toast('Saved, but the hosted bridge refused it', 'err');
        refreshSheet();
      },
    }),
    navRow('Address', {
      value: host,
      sub: 'Only if you run the ivx/ai API yourself',
      onclick: async () => {
        const next = await promptText({
          title: 'Hosted bridge address',
          value: h.url,
          placeholder: bridge.HOSTED_URL,
        });
        if (next === null) return;
        await bridge.configureHosted({ url: next.trim() });
        refreshSheet();
      },
    }),
    linkRow('Get a token', API_HELP, 'Sign in with a wallet to make one'),
  ], note);
}

/** The line under the switch: what is true right now, and what to do about it. */
function statusNote(s) {
  if (!s.enabled && s.hosted.ready) {
    return 'Off. Calls to online services go through the hosted bridge below; ' +
      'endpoints on this machine go straight from this page.';
  }
  if (!s.enabled) {
    return bridge.EXTENSION
      ? 'Off. Provider calls go straight from this extension, which works for ' +
        'any endpoint that answers browser origins and for the ones you have ' +
        'allowed — turn it on for the rest, or to run local MCP servers.'
      : 'Off. Provider calls go straight from this page, which only works ' +
        'for endpoints that allow browser origins.';
  }
  if (!s.reachable) {
    return `Nothing answered at ${s.url}. Start it with \`ivxai-bridge\`, or ` +
      'turn this off to go direct again.';
  }
  if (!s.health.originAllowed) {
    return `The bridge is running but does not accept ${location.origin}. ` +
      `Restart it with --allow-origin ${location.origin}.`;
  }
  if (s.outdated) {
    return `The bridge speaks protocol ${s.health.protocol} and this app speaks ` +
      `${bridge.PROTOCOL}. Update whichever is older.`;
  }
  return `On. Provider calls go via ${s.url}, which is on this machine. ` +
    `Bridge ${s.health.version}.`;
}

async function lookForBridge() {
  const busy = toast('Looking on this machine…', '', 8000);
  const hit = await bridge.detect();
  busy.remove();

  if (!hit) {
    toast('No bridge answered. Is it running?', 'err');
    refreshSheet();
    return;
  }
  if (!hit.health.originAllowed) {
    toast(`Found a bridge at ${hit.url}, but it refuses ${location.origin}`, 'err');
    refreshSheet();
    return;
  }
  try {
    await bridge.enable({ url: hit.url });
    toast(`Bridge found at ${hit.url}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  refreshSheet();
}

async function recheckBridge() {
  const s = await bridge.verify();
  toast(s.ready ? 'Bridge is answering' : 'Bridge did not answer', s.ready ? 'ok' : 'err');
  refreshSheet();
}

function bridgeAboutScreen() {
  const point = (title, body) => el('div', { class: 'intro-point' }, [
    el('div', { class: 'intro-title', text: title }),
    el('p', { class: 'intro-body', text: body }),
  ]);

  return el('div', {}, [
    el('div', { class: 'intro' }, [
      point('A browser rule, not an endpoint problem',
        'A page may only call a server that says it accepts pages. Ollama does ' +
        'not by default, and neither do plenty of local runtimes and private ' +
        'proxies. They are running fine — the browser simply will not let this ' +
        'page speak to them.'),
      point('The bridge is a program on your machine',
        'It listens on loopback and forwards the call for you, then streams the ' +
        'answer back. It never stores anything, and your key goes to the same ' +
        'endpoint it would have gone to anyway.'),
      point('It only answers pages you allow',
        'By default that is this app and anything on localhost. A browser sets ' +
        'the origin itself and a page cannot fake it, so a site you happen to ' +
        'visit cannot borrow the bridge to reach your network.'),
      point('Or install the app instead',
        'The desktop and mobile builds carry the same bridge inside them, so ' +
        'there is nothing to run and nothing to switch on.'),
    ]),
    el('div', { class: 'sheet-actions' }, [
      el('a', {
        class: 'btn btn-secondary btn-block', href: BRIDGE_HELP,
        target: '_blank', rel: 'noopener noreferrer', text: 'How to get it',
      }),
    ]),
  ]);
}

/* ── appearance ────────────────────────────────────────────── */

function appearanceScreen() {
  const ui = app.getUI();
  const pick = async (title, key, items) => {
    const value = await chooseFromList({ title, items, selected: ui[key] });
    if (!value) return;
    app.setUI({ [key]: value });
    app.applyAppearance();
    refreshSheet();
  };

  return el('div', {}, [
    group(null, [
      navRow('Theme', {
        value: { auto: 'System', dark: 'Dark', light: 'Light' }[ui.theme],
        onclick: () => pick('Theme', 'theme', [
          { value: 'auto', label: 'Follow system' },
          { value: 'dark', label: 'Dark' },
          { value: 'light', label: 'Light' },
        ]),
      }),
      navRow('Text width', {
        value: { narrow: 'Narrow', default: 'Default', wide: 'Wide', full: 'Full' }[ui.width] || 'Default',
        onclick: () => pick('Text width', 'width', [
          { value: 'narrow', label: 'Narrow' },
          { value: 'default', label: 'Default' },
          { value: 'wide', label: 'Wide' },
          { value: 'full', label: 'Full width' },
        ]),
      }),
    ]),
    group(null, [
      switchRow('Enter sends the message', ui.sendOnEnter, v => app.setUI({ sendOnEnter: v })),
    ], 'With this off, Enter starts a new line and ⌘/Ctrl+Enter sends.'),
  ]);
}

/* ── privacy & data ────────────────────────────────────────── */

function privacyScreen() {
  const { encrypted, unlocked } = vault.status();

  return el('div', {}, [
    group('API keys', encrypted
      ? [
          actionRow(unlocked ? 'Keys are unlocked for this session' : 'Keys are locked', {
            sub: unlocked ? 'Tap to lock them again' : 'Tap to unlock',
            onclick: async () => {
              if (unlocked) { vault.lock(); app.refreshChrome(); refreshSheet(); toast('Keys locked'); }
              else { await app.askUnlock(); refreshSheet(); }
            },
          }),
          actionRow('Turn off encryption', { danger: true, onclick: disableEncryption }),
        ]
      : [actionRow('Encrypt keys with a passphrase', { onclick: enableEncryption })],
      encrypted
        ? 'AES-GCM with a PBKDF2-derived key. The key lives in memory only, so you unlock once per session.'
        : 'Keys currently sit in IndexedDB in the clear, readable by anyone who can use this browser unlocked.'),

    group('Sharing', [
      switchRow('Shorten share links with TinyURL', Boolean(app.getUI().shareShortener),
        checked => {
          app.setUI({ shareShortener: checked });
          toast(checked
            ? 'Share links may be sent to tinyurl.com to be shortened'
            : 'Share links stay in the browser — copy the full link instead', 'ok');
        }),
    ], 'Off by default. Shortening hands the whole link — the chat rides ' +
       'inside it — to tinyurl.com. The full link always works without any ' +
       'third party.'),

    group('Backup', [
      actionRow('Export everything', { sub: 'Chats, providers and settings', onclick: () => exportAll(false) }),
      actionRow('Export including API keys', { sub: 'The file will contain your secrets', onclick: () => exportAll(true) }),
      actionRow('Import a backup', { onclick: importBackup }),
    ]),

    group('Danger zone', [
      actionRow('Delete all chats', { danger: true, onclick: deleteAllChats }),
      actionRow('Erase everything', { danger: true, sub: 'Chats, keys, settings and the offline cache', onclick: eraseAll }),
    ]),
  ]);
}

async function enableEncryption() {
  const pass = await promptText({ title: 'Choose a passphrase', placeholder: 'At least 8 characters' });
  if (pass === null) return;
  if (pass.length < 8) { toast('Use at least 8 characters', 'err'); return; }
  const again = await promptText({ title: 'Repeat it', placeholder: 'Same passphrase' });
  if (again === null) return;
  if (again !== pass) { toast('They do not match', 'err'); return; }
  await vault.enable(pass);
  app.refreshChrome();
  refreshSheet();
  toast('API keys encrypted', 'ok');
}

async function disableEncryption() {
  const ok = await confirmAction({
    title: 'Turn off encryption?',
    body: 'Your API keys will be stored unencrypted in this browser.',
    okText: 'Turn off',
  });
  if (!ok) return;
  try {
    await vault.disable();
    app.refreshChrome();
    refreshSheet();
    toast('Encryption off');
  } catch (err) { toast(err.message, 'err'); }
}

async function exportAll(withKeys) {
  const kv = (await store.kvAll()).filter(r => r.key !== 'secrets' && r.key !== 'vault');
  if (withKeys) {
    try {
      kv.push({ key: 'secrets', value: vault.exportSecrets() });
    } catch (err) { toast(err.message, 'err'); return; }
  }
  const messages = await store.allMessages();
  // Attachments are base64 inside the same file. It makes a backup with
  // pictures in it a big file, and a backup that dropped them would be a
  // backup of half the chat.
  const attachments = await attach.exportRecords(messages);
  downloadJSON(`ivx-ai-chat-backup-${new Date().toISOString().slice(0, 10)}.json`, {
    app: 'ivx-ai-chat', version: 1, exportedAt: new Date().toISOString(),
    containsKeys: withKeys,
    conversations: await store.listConversations(),
    messages,
    kv,
    ...(attachments.length ? { attachments } : {}),
  });
  toast(withKeys ? 'Exported — this file contains your API keys' : 'Exported', 'ok', 7000);
}

function importBackup() {
  const picker = el('input', { type: 'file', accept: 'application/json,.json' });
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    if (!file) return;
    let bundle;
    try {
      bundle = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON', 'err');
      return;
    }
    const single = bundle.conversation && Array.isArray(bundle.messages);
    const conversations = single ? [bundle.conversation] : (bundle.conversations || []);
    const messages = bundle.messages || [];
    if (!conversations.length && !messages.length && !bundle.kv) {
      toast('Nothing recognisable in that file', 'err');
      return;
    }
    const attachments = attach.restoreRecords(bundle.attachments);
    const ok = await confirmAction({
      title: 'Import this backup?',
      body: `${conversations.length} chats and ${messages.length} messages will be merged in.` +
        (attachments.length ? ` ${attachments.length} attachments come with them.` : '') +
        (bundle.containsKeys ? ' It also contains API keys.' : ''),
      okText: 'Import',
      danger: false,
    });
    if (!ok) return;

    const secrets = (bundle.kv || []).find(r => r.key === 'secrets')?.value;
    const kv = (bundle.kv || []).filter(r => r.key !== 'secrets' && r.key !== 'vault');
    await store.importBundle({ conversations, messages, kv, attachments });
    if (secrets && typeof secrets === 'object') {
      try { await vault.importSecrets(secrets); } catch (err) { toast(err.message, 'err'); }
    }
    await app.reloadData();
    refreshSheet();
    toast('Import complete', 'ok');
  });
  picker.click();
}

async function deleteAllChats() {
  const ok = await confirmAction({
    title: 'Delete all chats?',
    body: 'Providers and keys are kept. Every conversation is removed.',
    okText: 'Delete all',
  });
  if (!ok) return;
  await app.deleteAllChats();
  toast('All chats deleted');
}

async function eraseAll() {
  const ok = await confirmAction({
    title: 'Erase everything?',
    body: 'Chats, providers, API keys, preferences and the offline cache. This cannot be undone.',
    okText: 'Erase',
  });
  if (!ok) return;
  await store.wipeEverything();
  location.reload();
}

/* ── about ─────────────────────────────────────────────────── */

/* __VERSIONS__ is stamped in by vite.config.js from what is actually installed. */
const version = (key, licence) => {
  const v = (typeof __VERSIONS__ === 'object' && __VERSIONS__[key]) || '';
  return v ? `v${v} · ${licence}` : licence;
};

/* The app's own version, from package.json by the same route. */
const appVersion = () => (typeof __VERSIONS__ === 'object' && __VERSIONS__.app) || '';

/* The whole point of the project is that nobody pays for it with their
   attention or their data, which leaves exactly one way to fund it. */
const SPONSOR_URL = 'https://github.com/sponsors/0xcrypto';
const SOURCE_URL = 'https://github.com/ivxlabs/chat';
const LICENCE_URL = `${SOURCE_URL}/blob/main/LICENSE`;
/* The native shell is a separate repository, with its own copy of the terms. */
const APP_SOURCE_URL = 'https://github.com/ivxlabs/ivxai-app';
const APP_LICENCE_URL = `${APP_SOURCE_URL}/blob/main/LICENSE`;

const bigLink = (href, text, kind) => el('a', {
  class: `btn btn-${kind} btn-block`, href, target: '_blank', rel: 'noopener noreferrer', text,
});

function aboutScreen() {
  const para = text => el('p', { class: 'group-note', text });
  return el('div', {}, [
    el('div', { class: 'sheet-actions' }, [
      bigLink(SPONSOR_URL, '♥  Sponsor this project', 'primary'),
      bigLink(SOURCE_URL, '★  Star it on GitHub', 'secondary'),
    ]),
    el('div', { class: 'group' }, [
      para('No ads, no trackers, no accounts and no paid tier. If it is useful ' +
           'to you, sponsoring keeps it that way — and a star helps other people ' +
           'find it.'),
    ]),

    group('Created by @0xcrypto', [
      linkRow('X', 'https://x.com/0xcrypto', 'x.com/0xcrypto'),
      linkRow('LinkedIn', 'https://linkedin.com/in/0xcrypto', 'linkedin.com/in/0xcrypto'),
      linkRow('GitHub', 'https://github.com/0xcrypto', 'github.com/0xcrypto'),
      linkRow('Blog', 'https://eval.blog', 'eval.blog'),
    ]),
    el('div', { class: 'group' }, [
      para('A lightweight, browser-based chat client designed for users who want total ' +
           'control over their data and their AI interactions. No backend, no accounts, ' +
           'no analytics, and no third-party scripts or fonts at runtime — everything it ' +
           'loads comes from this origin.'),
      para('The only network requests it makes are the ones you ask for: chat completions ' +
           'and model lists, sent straight to the endpoint you configured.'),
    ]),
    group(null, [
      actionRow('What is ivx/ai Chat?', { sub: 'The welcome tour', onclick: () => openIntro() }),
    ]),

    // Free software: the people running it should be able to find the source
    // and the terms without leaving the app.
    group('This app', [
      appVersion() ? actionRow('Version', { sub: `v${appVersion()}` }) : null,
      linkRow('Source code', SOURCE_URL, 'github.com/ivxlabs/chat'),
      linkRow('Licence', LICENCE_URL, 'GNU GPL v3 or later'),
    ], 'Free software: you may use, study, share and change it, provided your ' +
       'changes carry the same licence.'),

    group('Desktop app', [
      linkRow('Source code', APP_SOURCE_URL, 'github.com/ivxlabs/ivxai-app'),
      linkRow('Licence', APP_LICENCE_URL, 'GNU GPL v3 or later'),
    ], 'The native build wraps this same page and carries the bridge inside it.'),

    group('Where your data lives', [
      actionRow('IndexedDB · ivx', { sub: 'Conversations, messages, providers, API keys' }),
      actionRow('localStorage · ivx.ui', { sub: 'Theme and layout preferences' }),
      actionRow('Cache Storage', { sub: 'The app shell and WebLLM model weights' }),
    ]),
    el('div', { class: 'group' }, [
      para('Browsers require the provider to allow cross-origin calls. OpenRouter, OpenAI ' +
           'and Anthropic do. For Ollama, start it with OLLAMA_ORIGINS set to this app’s origin.'),
    ]),

    group('Built with', [
      linkRow('Vite', 'https://vite.dev', version('vite', 'MIT')),
      linkRow('Halfmoon CSS', 'https://www.gethalfmoon.com', version('halfmoon', 'MIT')),
      // The installed version is @fontsource's packaging, not IBM's own release.
      linkRow('IBM Plex', 'https://www.ibm.com/plex/', 'SIL OFL · via @fontsource'),
      linkRow('WebLLM', 'https://github.com/mlc-ai/web-llm', version('webllm', 'Apache-2.0')),
      linkRow('highlight.js', 'https://highlightjs.org', version('hljs', 'BSD-3-Clause')),
    ], 'All five are bundled into the build and served from this origin — none of ' +
       'them is fetched from a CDN at runtime. WebLLM downloads model weights ' +
       'from HuggingFace, once per model, into Cache Storage.'),
  ]);
}
