// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Mentions: saying what you are talking about.

   Type `@` in the composer and pick an open tab, an agent or one of your own
   chats. What you picked is named in the request, so "summarize it" has an
   *it* — and for a tab, it is also what makes the page readable: the snapshot
   and screenshot tools in page-tools.js work on mentioned tabs and on nothing
   else. A tab you have not mentioned is not a page this app will read.

   Three kinds, and they carry three different things:

     tab     a title and an address, plus the tab it is. Extension only, and
             only for sites page tools is allowed on — see page-tools.js.
     agent   a name. The model can already delegate to it with `<ask>`; the
             mention is how a person says which one they meant.
     chat    the conversation's own messages, quoted into the request. This is
             the only kind that carries real content, and it is the reason a
             mention belongs to the conversation rather than to one message.

   That last point is worth stating plainly. A mention is made once and stays:
   `@` a tab, ask a question about it, then say "now screenshot it" and the
   second turn still knows which tab. So the set lives on the conversation and
   each message records what it added, which is what the chips under a message
   are painted from. */

import * as store from './store.js';

export const ICONS = {
  tab: 'ri-window-line',
  agent: 'ri-robot-2-line',
  chat: 'ri-chat-1-line',
};

/** How much of a mentioned chat is quoted. Long enough to be the context the
    person meant, short enough that three of them do not crowd out the
    question. The cut is announced rather than made silently. */
const CHAT_LIMIT = 6000;

/** How many of a chat's messages are worth quoting, newest last. */
const CHAT_MESSAGES = 30;

/* An id that says what it points at, so one list can hold all three kinds and
   a stale one can be recognised without being resolved. */
const idFor = (kind, key) => `${kind}:${key}`;

export const tabMention = tab => ({
  kind: 'tab', id: idFor('tab', tab.tabId), label: tab.title || tab.host || 'Untitled tab',
  tabId: tab.tabId, windowId: tab.windowId ?? null, url: tab.url || '', host: tab.host || '',
});

export const agentMention = agent => ({
  kind: 'agent', id: idFor('agent', agent.id), label: agent.name, agentId: agent.id,
});

export const chatMention = conv => ({
  kind: 'chat', id: idFor('chat', conv.id), label: conv.title || 'Untitled', convId: conv.id,
});

/** The one-line hint under a name in the picker and under a chip. */
export function describe(mention) {
  if (mention.kind === 'tab') return mention.host || mention.url || 'Open tab';
  if (mention.kind === 'agent') return 'Agent';
  return 'Chat';
}

/**
 * What typing `@something` offers.
 *
 * Ordered by kind rather than by score, because the three are not competing:
 * a person reaching for a tab is not half-reaching for a chat, and a list that
 * reshuffles as they type is harder to aim at than one that does not. Within a
 * kind, a name that starts with what was typed comes before one that merely
 * contains it.
 */
export function search(query, { tabs = [], agents = [], conversations = [] }) {
  const q = String(query || '').trim().toLowerCase();
  const rank = candidates => candidates
    .map(c => ({ c, at: c.label.toLowerCase().indexOf(q) }))
    // A tab also matches on its address, which is often what someone
    // remembers about a page whose title they do not.
    .filter(({ c, at }) => !q || at >= 0 || (c.kind === 'tab' && c.url.toLowerCase().includes(q)))
    .sort((a, b) => (a.at < 0) - (b.at < 0) || a.at - b.at)
    .map(({ c }) => c);

  return [
    ...rank(tabs.map(tabMention)),
    ...rank(agents.map(agentMention)),
    // Drafts have nothing in them to be context, and the chat you are in is
    // not something to quote into itself.
    ...rank(conversations.filter(c => !c.draft).map(chatMention)),
  ];
}

/** Merge new mentions into the set a conversation carries, newest first and
    without repeats, so `@`-ing the same tab twice changes nothing. */
export function merge(existing = [], added = []) {
  const out = [...added];
  for (const m of existing) if (!out.some(x => x.id === m.id)) out.push(m);
  return out.slice(0, 12);
}

/**
 * The system-prompt section naming what is being talked about.
 *
 * Chats are quoted; tabs and agents are named. A tab's *contents* are not
 * here — reading a page is a tool call, and this section is what tells the
 * model those tools have something to point at.
 */
export async function promptSection(mentions = []) {
  if (!mentions.length) return '';

  const lines = [];
  const tabs = mentions.filter(m => m.kind === 'tab');
  const agents = mentions.filter(m => m.kind === 'agent');
  const chats = mentions.filter(m => m.kind === 'chat');

  if (tabs.length) {
    lines.push('Open browser tabs:');
    for (const t of tabs) lines.push(`- ${t.label} — ${t.url} (tab ${t.tabId})`);
    lines.push('You have not been shown what is on these pages. The tools below ' +
      'are how you read one; do not describe a page you have not read.');
  }
  if (agents.length) {
    lines.push('Agents:');
    for (const a of agents) lines.push(`- ${a.label}`);
  }
  for (const chat of chats) {
    const transcript = await quote(chat.convId);
    lines.push(`Chat “${chat.label}”:\n${transcript}`);
  }

  return '\n\n# What this is about\n' +
    'The person named these, so "it" and "that" in what they ask most likely ' +
    'mean one of them.\n' + lines.join('\n');
}

/** One chat, as a transcript the model can read. Cut from the front when it
    is long: the end of a conversation is the part still being talked about. */
async function quote(convId) {
  let messages;
  try {
    messages = await store.listMessages(convId);
  } catch {
    return '(This chat could not be read.)';
  }
  const usable = messages
    .filter(m => m.role !== 'system' && String(m.content || '').trim())
    .slice(-CHAT_MESSAGES);
  if (!usable.length) return '(This chat is empty.)';

  const body = usable
    .map(m => `${m.role === 'user' ? 'Them' : m.role === 'tool' ? 'Tool' : 'Assistant'}: ${m.content}`)
    .join('\n');
  const cut = body.length > CHAT_LIMIT;
  return (cut ? `(earlier messages left out)\n${body.slice(-CHAT_LIMIT)}` : body)
    .split('\n').map(line => `  ${line}`).join('\n');
}

/**
 * Drop mentions that no longer point at anything.
 *
 * A tab is closed, an agent deleted, a chat removed — and a model told about
 * any of them answers as though it were still there. Tabs are checked against
 * what is open now; the other two against what the app holds.
 */
export function prune(mentions = [], { tabIds = null, agents = [], conversations = [] }) {
  return mentions.filter(m => {
    if (m.kind === 'tab') return tabIds ? tabIds.has(m.tabId) : true;
    if (m.kind === 'agent') return agents.some(a => a.id === m.agentId);
    return conversations.some(c => c.id === m.convId);
  });
}
