// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* The right-click menu.

   Every panel in this app is a bottom sheet, and a sheet is the wrong shape
   for "what can I do with the thing under the pointer": by the time it is up
   it is covering the thing you pointed at. This is the other shape — a small
   menu at the pointer, holding only the actions that belong to what was
   clicked.

   Presentation is all this module owns. A caller hands over groups of items
   and a point; placement, keyboard and every way a menu can be dismissed are
   settled here so no caller has to remember them. What goes in a menu is
   decided in main.js, which is the only place that knows what is on screen.

   One menu at a time: opening closes whatever was open, which is also what
   makes right-clicking straight from one menu onto something else work. */

import { el } from './ui.js';

const EDGE = 8;             // the closest to a viewport edge a menu may sit

/** `{ node, dismiss }` while a menu is up, null otherwise. */
let live = null;

export const menuIsOpen = () => Boolean(live);

export function closeMenu() {
  if (!live) return;
  const { node, dismiss } = live;
  live = null;              // cleared first: dismiss() may call back in here
  dismiss();
  node.remove();
}

/**
 * Put a menu on screen at a point.
 *
 * `sections` are groups of items with a rule drawn between them. Falsy items
 * and empty groups are dropped, so a caller can write a whole menu as one
 * literal and let conditions decide what survives — the alternative is a pile
 * of pushes, and menus differ by a row or two between surfaces.
 *
 * An item is `{ label, onSelect, danger, disabled, hint }`. Nothing opens
 * a submenu: a menu you have to steer through is a menu, not a shortcut.
 */
export function openMenu({ x, y, heading = '', sections = [], focusFirst = false }) {
  closeMenu();

  const groups = sections.map(group => group.filter(Boolean)).filter(group => group.length);
  if (!groups.length) return;

  const node = el('div', {
    class: 'ctx-menu', role: 'menu', tabIndex: -1,
    'aria-label': heading || 'Actions',
  });
  if (heading) node.append(el('div', { class: 'ctx-heading', text: heading }));
  groups.forEach((group, i) => {
    if (i) node.append(el('div', { class: 'ctx-sep', role: 'separator' }));
    for (const item of group) node.append(itemNode(item));
  });

  document.body.append(node);
  place(node, x, y);

  /* Focus goes into the menu either way: it is what makes Escape and the
     arrow keys land here rather than on the page behind. A pointer opened it
     on something, though, so highlighting a row it did not choose would be
     the app guessing — only a keyboard-opened menu starts on an item. */
  const enabled = () => [...node.querySelectorAll('.ctx-item:not([disabled])')];
  if (focusFirst) enabled()[0]?.focus();
  else node.focus({ preventScroll: true });

  const previous = document.activeElement === node ? null : document.activeElement;

  /* Captured, and stopped dead: while a menu is up it owns these keys. Escape
     otherwise closes the menu and the drawer behind it in one press, and the
     arrows scroll the thread the menu is anchored to. */
  const onKey = ev => {
    if (ev.key === 'Escape' || ev.key === 'Tab') { stop(ev); closeMenu(); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(ev.key)) return;
    stop(ev);
    const list = enabled();
    if (!list.length) return;
    const at = list.indexOf(document.activeElement);
    const next = ev.key === 'Home' ? 0
      : ev.key === 'End' ? list.length - 1
      : ev.key === 'ArrowDown' ? (at + 1) % list.length
      : (at <= 0 ? list.length : at) - 1;
    list[next].focus();
  };
  const onPointerDown = ev => { if (!node.contains(ev.target)) closeMenu(); };
  /* Captured, because the thing that scrolls is usually the thread or the
     chat list rather than the window, and a menu anchored to a point the
     content has moved out from under is pointing at nothing. */
  const onScroll = ev => { if (!node.contains(ev.target)) closeMenu(); };

  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  node.addEventListener('contextmenu', ev => ev.preventDefault());

  live = {
    node,
    dismiss: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('blur', closeMenu);
      // Only when the menu still holds it: an action that opened a sheet has
      // already moved focus somewhere it belongs, and taking it back would
      // undo that.
      if (node.contains(document.activeElement) && previous?.isConnected) {
        previous.focus({ preventScroll: true });
      }
    },
  };
}

function itemNode(item) {
  return el('button', {
    class: `ctx-item${item.danger ? ' danger' : ''}`,
    type: 'button', role: 'menuitem', tabIndex: -1,
    disabled: Boolean(item.disabled),
    // Closed before the action runs, not after: most of these open a sheet or
    // a confirmation, and a menu still on screen underneath one reads as two
    // things asking at once.
    onclick: () => { closeMenu(); item.onSelect?.(); },
  }, [
    el('span', { class: 'ctx-label', text: item.label }),
    item.hint ? el('span', { class: 'ctx-hint', text: item.hint }) : null,
  ]);
}

function place(node, x, y) {
  const { offsetWidth: w, offsetHeight: h } = node;
  const { innerWidth: vw, innerHeight: vh } = window;
  /* Flipped rather than slid along the edge: a menu that slides ends up under
     the pointer, and then the row it lands on is one a stray click can take. */
  const left = x + w + EDGE > vw ? x - w : x;
  const top = y + h + EDGE > vh ? y - h : y;
  node.style.left = `${clamp(left, EDGE, Math.max(EDGE, vw - w - EDGE))}px`;
  node.style.top = `${clamp(top, EDGE, Math.max(EDGE, vh - h - EDGE))}px`;
}

const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

const stop = ev => { ev.preventDefault(); ev.stopPropagation(); };
