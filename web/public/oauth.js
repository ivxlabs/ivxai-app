// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 0xcrypto

/* Hand the authorization code back to the window that opened this one.

   A separate file rather than an inline script because the app ships under a
   `script-src 'self'` policy, which an inline script is exactly what is
   excluded by — and a redirect page that only works when the policy is loose
   is a redirect page that stops working the day it is tightened.

   The code is passed to `postMessage` with this page's own origin as the
   target, so it cannot be delivered to anything but the app that opened this.
   It is not stored, not logged and not put anywhere a later page could read
   it: this document's whole life is one message long. */

(() => {
  const params = {};
  // Query for nearly every server; fragment for the few that answer that way.
  for (const source of [location.search, location.hash.replace(/^#/, '')]) {
    for (const [key, value] of new URLSearchParams(source)) {
      if (!(key in params)) params[key] = value;
    }
  }

  const title = document.getElementById('title');
  const detail = document.getElementById('detail');

  if (!window.opener) {
    // Opened directly, or the opener has gone. There is nobody to hand this
    // to, and it must not be left sitting in the address bar of a page that
    // stays open.
    title.textContent = 'Nothing to finish here';
    detail.textContent = 'This page completes a sign-in started by the chat app. '
      + 'Start it again from Settings → MCP servers.';
    history.replaceState(null, '', location.pathname);
    return;
  }

  window.opener.postMessage({ type: 'ivx:oauth', params }, location.origin);
  title.textContent = params.error ? 'Sign-in was refused' : 'Signed in';
  detail.textContent = 'You can close this window.';
  // The app closes this as soon as it has the code; this is for the case where
  // it cannot — a browser that will not let a script close a window it did
  // not itself open leaves the sentence above on screen instead.
  setTimeout(() => window.close(), 400);
})();
