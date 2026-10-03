// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Page tools: the part that runs inside the page.

   Select some text and a small bar appears under it — summarize, translate,
   ask an agent. Focus a text field and a chip appears beside it — write with
   an agent. Either way this script only carries the request; the chat is the
   app's, in the side panel, with the agents and keys the person already set
   up. Nothing here talks to a provider and nothing here keeps anything.

   Three rules shape all of it:

     - This script is not in the manifest. It is registered at runtime, for
       the sites the person allowed, by background.js — so an install asks for
       nothing and a site that was never allowed never sees this file. See
       `syncPageTools` there.
     - The page is not ours. Its CSS would restyle anything we add and its
       scripts can read anything we leave in the DOM, so the UI lives in a
       shadow root under a host with `all: initial`, and the only thing that
       leaves this script is what the person clicked.
     - The field is written to by a tool call, not by whatever the model said.
       The model asks for a write in a `<write>` block, the app runs it as a
       tool, and the text arrives here as an argument. A reply that was meant
       for the reader — "Sure, here's a draft:" — is then not what lands in
       someone's email box. See `applyWrite` and page-tools.js.

   Runs in every frame, because a text field is as likely to be in an editor's
   iframe as in the top document, and a selection belongs to exactly one frame
   either way. The frame that owns the selection is the frame that shows the
   bar. */

/* Registered dynamically, and also injected into tabs that were already open
   when the site was allowed — so one frame can be asked to run this twice. An
   isolated world gives each extension its own global per frame, so a flag
   there is seen by this script and by nothing else in the page.

   Inside a function because the guard has to be able to leave: a content
   script is a classic script, with no top-level return to take. */
(() => {

  if (globalThis.__ivxPageTools) return;
  globalThis.__ivxPageTools = true;

  const api = globalThis.browser ?? globalThis.chrome;

  /* What the bar offers a selection. `ask` opens a composer first; the other two
     go straight to the panel, because the instruction is the button. */
  const SELECTION_ACTIONS = [
    { action: 'summarize', label: 'Summarize' },
    { action: 'translate', label: 'Translate' },
    { action: 'ask', label: 'Ask agent', composes: true },
  ];

  /** Longer than this and it is a page, not a phrase. The app sees what the
      person selected; this only keeps one careless ⌘A from filling a request
      with a megabyte of markup. */
  const MAX_SELECTION = 20000;

  /* ── the fields this frame has offered ─────────────────────── */

  /* A write comes back long after the click that asked for it, by which time
     focus has moved — to the panel, to another field, out of the page. So the
     element is kept here under an id that travels with the request, and the
     write is applied to that element whether or not it is still focused.

     Bounded and in insertion order: a long-lived page can focus a great many
     fields, and an entry is only worth keeping until its answer arrives. */
  const fields = new Map();
  let fieldSeq = 0;
  const MAX_FIELDS = 32;

  function remember(node) {
    const id = `f${++fieldSeq}`;
    fields.set(id, node);
    while (fields.size > MAX_FIELDS) fields.delete(fields.keys().next().value);
    return id;
  }

  /** Whether a node is something a person types into — and that we may write to.
      A readonly or disabled field is neither. */
  function editable(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.isContentEditable) return true;
    const tag = node.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    if (node.disabled || node.readOnly) return false;
    if (tag === 'TEXTAREA') return true;
    /* The text-like input types. A date picker or a colour well has a value
       that is not prose, and nothing an agent writes belongs in one.

       No password field, and that one is not about prose. The chip carries
       the field's current contents up to the chat so the model can be asked to
       revise rather than only to compose — which is right for a paragraph and
       wrong for a password, and not a distinction worth leaving to whoever
       clicks. A password manager is better at this than any of us. */
    return /^(?:text|search|email|url|tel|number|)$/i.test(node.type || 'text');
  }

  /** What is already in a field, so the model can be asked to rewrite rather
      than only to compose. */
  const valueOf = node => (node.isContentEditable ? node.innerText : node.value) || '';

  /**
   * Put the agent's text into the field.
   *
   * `execCommand` first, and not for nostalgia: it is the one way to change a
   * field that the page's own framework notices. React and friends track the
   * value through their own listeners, and a value assigned straight to the
   * property updates the DOM while leaving the framework's copy — and so the
   * form's state — on the old text. execCommand('insertText') edits the way a
   * keystroke does, so every listener the page has runs, in order.
   *
   * The fallback covers the field types execCommand does not reach (number
   * inputs, chiefly), and puts the events out by hand so at least the listeners
   * that watch for them fire.
   */
  function applyWrite(node, text, mode) {
    if (!node.isConnected) return 'That field is no longer on the page.';
    if (!editable(node)) return 'That field cannot be written to.';

    node.focus({ preventScroll: false });
    const replacing = mode !== 'insert';

    if (node.isContentEditable) {
      const selection = node.ownerDocument.getSelection();
      if (replacing) {
        const range = node.ownerDocument.createRange();
        range.selectNodeContents(node);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else if (replacing) {
      node.select();
    }

    let ok = false;
    try {
      ok = node.ownerDocument.execCommand('insertText', false, text);
    } catch {
      ok = false;
    }

    if (!ok) {
      if (node.isContentEditable) {
        if (replacing) node.textContent = text;
        else node.append(node.ownerDocument.createTextNode(text));
      } else {
        // Through the prototype's own setter, which is what a framework's
        // value-tracker hooks; assigning to `node.value` would slip past it.
        const proto = node instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        const next = replacing ? text : valueOf(node) + text;
        if (set) set.call(node, next); else node.value = next;
      }
      node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      node.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    }

    return null;
  }

  /* ── the bar ───────────────────────────────────────────────── */

  /* One host for both affordances: the selection bar and the field chip are
     never wanted at once, and sharing the host means showing either one hides
     the other without a second thought. */
  let host = null;
  let root = null;
  /* What the panel is about right now: the selection bar, or a field's chip.
     Null when nothing is showing. */
  let showing = null;

  const STYLE = `
  :host { all: initial; }
  .bar {
    position: absolute; z-index: 2147483647;
    display: flex; gap: 2px; align-items: center;
    padding: 3px; border-radius: 9px;
    background: #1c1d21; color: #f3f4f6;
    border: 1px solid #383a42;
    box-shadow: 0 6px 24px rgba(0, 0, 0, .34);
    font: 500 13px/1.3 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  button {
    all: unset; box-sizing: border-box;
    padding: 6px 10px; border-radius: 6px; cursor: pointer;
    color: inherit; font: inherit; white-space: nowrap;
  }
  button:hover, button:focus-visible { background: #33353d; }
  button.go { background: #4f6bed; }
  button.go:hover, button.go:focus-visible { background: #6079f0; }
  .compose { flex-direction: column; align-items: stretch; gap: 6px; padding: 8px; width: 300px; }
  .compose textarea {
    all: unset; box-sizing: border-box;
    min-height: 56px; padding: 6px 8px; border-radius: 6px;
    background: #121317; border: 1px solid #383a42; color: inherit;
    font: 400 13px/1.45 inherit; white-space: pre-wrap; overflow-wrap: anywhere;
  }
  .compose select {
    box-sizing: border-box; width: 100%; padding: 5px 6px; border-radius: 6px;
    background: #121317; border: 1px solid #383a42; color: inherit; font: inherit;
  }
  .row { display: flex; gap: 6px; align-items: center; }
  .row select { flex: 1; min-width: 0; }
  .quote {
    margin: 0; max-height: 46px; overflow: hidden; color: #a7a9b4;
    font: 400 12px/1.4 inherit;
  }
  `;

  function surface() {
    if (host?.isConnected) return root;
    host = document.createElement('div');
    // A name that says whose it is, for anyone who opens the inspector and
    // wonders what this element is doing in their page.
    host.setAttribute('data-ivx-page-tools', '');
    root = host.attachShadow({ mode: 'open' });
    root.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
    // documentElement, not body: a frame may not have a body yet, and this way
    // the host sits outside anything the page's own layout will reflow.
    document.documentElement.append(host);
    return root;
  }

  function hide() {
    showing = null;
    if (host?.isConnected) host.remove();
    host = null;
    root = null;
  }

  /**
   * Put the panel at a rectangle, in document coordinates so it travels with
   * the page rather than sliding over it as the page scrolls.
   *
   * Below the rectangle by preference, above it when that would run off the
   * bottom, and always far enough inside the left and right edges to be whole.
   */
  function place(node, rect) {
    const doc = document.documentElement;
    node.style.visibility = 'hidden';
    node.style.left = '0';
    node.style.top = '0';
    const { width, height } = node.getBoundingClientRect();
    const margin = 8;
    const room = doc.clientWidth - width - margin;
    const left = Math.max(margin, Math.min(rect.left, room));
    const below = rect.bottom + 6;
    const fits = below + height <= doc.clientHeight - margin;
    const top = fits ? below : Math.max(margin, rect.top - height - 6);
    node.style.left = `${left + window.scrollX}px`;
    node.style.top = `${top + window.scrollY}px`;
    node.style.visibility = '';
  }

  const button = (label, onclick, kind = '') => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = kind;
    node.textContent = label;
    // mousedown, not click: a click lands after the browser has already moved
    // focus, which for the field chip means the field we are about to write to
    // has been blurred and its page may have torn the editor down. Taking the
    // press stops that before it starts.
    node.addEventListener('mousedown', ev => { ev.preventDefault(); ev.stopPropagation(); });
    node.addEventListener('click', ev => { ev.preventDefault(); onclick(); });
    return node;
  };

  /** The bar a selection gets: one button per action, sent on the click. */
  function showSelectionBar(text, rect) {
    const shadow = surface();
    for (const old of shadow.querySelectorAll('.bar')) old.remove();
    const bar = document.createElement('div');
    bar.className = 'bar';
    for (const { action, label, composes } of SELECTION_ACTIONS) {
      bar.append(button(label, () => (composes
        ? showAskComposer(text, rect)
        : send(action, { text }))));
    }
    shadow.append(bar);
    showing = { kind: 'selection', text };
    place(bar, rect);
  }

  /** What "Ask agent" opens: the question, and who to put it to. */
  function showAskComposer(text, rect) {
    const shadow = surface();
    for (const old of shadow.querySelectorAll('.bar')) old.remove();

    const bar = document.createElement('div');
    bar.className = 'bar compose';

    const quote = document.createElement('p');
    quote.className = 'quote';
    quote.textContent = `“${text.replace(/\s+/g, ' ').slice(0, 140)}${text.length > 140 ? '…' : ''}”`;

    const question = document.createElement('textarea');
    question.placeholder = 'What do you want to know about this?';
    question.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); go(); }
      if (ev.key === 'Escape') { ev.preventDefault(); hide(); }
    });

    const agents = document.createElement('select');
    const row = document.createElement('div');
    row.className = 'row';
    row.append(agents, button('Ask', () => go(), 'go'));

    const go = () => {
      const prompt = question.value.trim();
      if (!prompt) { question.focus(); return; }
      send('ask', { text, prompt, agentId: agents.value || null });
    };

    bar.append(quote, question, row);
    shadow.append(bar);
    showing = { kind: 'ask', text };
    place(bar, rect);
    question.focus();
    fillAgents(agents);
  }

  /** What a focused field gets: a chip, which opens the same shape of composer
      aimed at the field instead of at the chat. */
  function showFieldChip(node) {
    const shadow = surface();
    for (const old of shadow.querySelectorAll('.bar')) old.remove();
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.append(button('Write with agent', () => showWriteComposer(node)));
    shadow.append(bar);
    showing = { kind: 'field', node };
    place(bar, node.getBoundingClientRect());
  }

  function showWriteComposer(node) {
    const shadow = surface();
    for (const old of shadow.querySelectorAll('.bar')) old.remove();

    const bar = document.createElement('div');
    bar.className = 'bar compose';

    const existing = valueOf(node).trim();
    const instruction = document.createElement('textarea');
    instruction.placeholder = existing
      ? 'How should the agent change what is in this field?'
      : 'What should the agent write here?';
    instruction.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); go(); }
      if (ev.key === 'Escape') { ev.preventDefault(); hide(); }
    });

    const agents = document.createElement('select');
    const row = document.createElement('div');
    row.className = 'row';
    row.append(agents, button('Write', () => go(), 'go'));

    const go = () => {
      const prompt = instruction.value.trim();
      if (!prompt) { instruction.focus(); return; }
      send('write', {
        prompt,
        agentId: agents.value || null,
        // The field's own description, so the request reads as a request about
        // a field on a page rather than as a bare instruction.
        field: {
          id: remember(node),
          label: labelFor(node),
          value: valueOf(node).slice(0, MAX_SELECTION),
          multiline: node.tagName === 'TEXTAREA' || node.isContentEditable,
        },
      });
    };

    bar.append(instruction, row);
    shadow.append(bar);
    showing = { kind: 'write', node };
    place(bar, node.getBoundingClientRect());
    instruction.focus();
    fillAgents(agents);
  }

  /** What this field is called, as a person reading the page would say it:
      whatever the page already tells a screen reader, and its placeholder or
      name when it tells one nothing. */
  function labelFor(node) {
    const text = [
      node.getAttribute('aria-label'),
      node.id && node.ownerDocument.querySelector(`label[for="${CSS.escape(node.id)}"]`)?.innerText,
      node.closest('label')?.innerText,
      node.getAttribute('placeholder'),
      node.getAttribute('name'),
    ].find(candidate => candidate && candidate.trim());
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  /**
   * Fill the agent picker from what the app last saved, opened on the agent
   * the panel is already talking to.
   *
   * The list is the app's and has to be fetched, so the picker is built with a
   * placeholder that already means the right thing — a request carrying no id
   * is answered by the active agent either way — and replaced by real names
   * when they arrive. If the app has never run in this browser, or the
   * background script cannot be reached, the placeholder is what stays, and it
   * still sends the request to the agent the person is looking at.
   */
  async function fillAgents(select) {
    select.replaceChildren(new Option('Active agent', ''));
    let known = [];
    let active = null;
    try {
      const reply = await api.runtime.sendMessage({ type: 'ivx:page-agents' });
      known = reply?.agents || [];
      active = reply?.active ?? null;
    } catch {
      return;   // background asleep; the placeholder covers it
    }
    if (!select.isConnected || !known.length) return;
    select.replaceChildren(...known.map(agent => new Option(agent.name, agent.id)));
    // Named rather than left implicit: "Active agent" says nothing about which
    // agent that is, and the chat it belongs to is in a panel the page cannot
    // see. Falling back to the first entry only when the active one is gone.
    if (active && known.some(agent => agent.id === active)) select.value = active;
  }

  /* ── what the page does ────────────────────────────────────── */

  /** The selection in this frame, if there is one worth acting on. */
  function selectionNow() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    // A selection inside a collapsed or off-screen element has no rectangle to
    // put a bar against, and nothing sensible to do about it.
    if (!rect.width && !rect.height) return null;
    return { text: text.slice(0, MAX_SELECTION), rect };
  }

  /* Both after the event rather than during it: on mouseup the browser has not
     finished settling the selection, and a selection made by dragging is only
     final once the button is up. */
  const afterSelection = () => setTimeout(() => {
    const found = selectionNow();
    if (found) showSelectionBar(found.text, found.rect);
    else if (showing?.kind === 'selection') hide();
  }, 0);

  document.addEventListener('mouseup', ev => {
    if (ev.target === host) return;          // a click on our own bar
    afterSelection();
  }, true);

  document.addEventListener('keyup', ev => {
    // Only the keys that move a selection. Typing into a field must not put a
    // bar over what is being typed.
    if (!ev.shiftKey && ev.key !== 'Shift') return;
    if (editable(ev.target)) return;
    afterSelection();
  }, true);

  document.addEventListener('focusin', ev => {
    if (ev.target === host) return;          // focus moving into our own panel
    if (editable(ev.target)) showFieldChip(ev.target);
    else if (showing?.kind === 'field') hide();
  }, true);

  document.addEventListener('focusout', ev => {
    if (showing?.kind !== 'field' || ev.target !== showing.node) return;
    // Focus moving into our own panel is the chip being used, not abandoned.
    if (ev.relatedTarget === host) return;
    hide();
  }, true);

  document.addEventListener('mousedown', ev => {
    if (ev.target === host) return;
    // A press outside the panel dismisses it — except the one that is about to
    // become a new selection, which afterSelection will replace it with anyway.
    if (showing && showing.kind !== 'selection') hide();
  }, true);

  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape' && showing) hide();
  }, true);

  /* The panel is positioned once, against where the thing was. Anything that
     moves the thing underneath it leaves it pointing at nothing, so it goes. */
  addEventListener('resize', hide, { passive: true });
  addEventListener('pagehide', hide, { passive: true });

  /* ── talking to the app ────────────────────────────────────── */

  /**
   * Hand a request to the app, and get out of the way.
   *
   * Sent straight from the click because opening a side panel needs the gesture
   * that click is — an await here and Chrome refuses to open anything. The panel
   * is where the answer appears, so there is nothing left for this frame to show
   * and the bar closes on the way out.
   */
  function send(action, payload) {
    const message = {
      type: 'ivx:page-action',
      action,
      ...payload,
      page: { url: location.href, title: document.title },
    };
    hide();
    // Nothing waits on the answer: the app reports what happened in the panel,
    // and a rejected promise here is a background script that went away between
    // the click and the call.
    api.runtime.sendMessage(message).catch(() => { /* the panel says so */ });
  }

  /** The one thing the app asks of this frame: put this text in that field. */
  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ivx:page-write') return false;
    const node = fields.get(message.fieldId);
    if (!node) {
      // Every frame of the tab is asked; the ones that never offered this field
      // say so, and the app takes the first frame that did the work.
      sendResponse({ ok: false, error: 'unknown-field' });
      return false;
    }
    // Kept, not dropped: a model that is told its text was too long, or is
    // asked for another pass, writes into the same field again. The registry's
    // own bound is what clears it out eventually.
    const error = applyWrite(node, String(message.text ?? ''), message.mode);
    sendResponse(error ? { ok: false, error } : { ok: true, label: labelFor(node) });
    return false;
  });
})();
