# The browser extension

The same chat app, packaged as an extension for Chrome, Firefox and Safari.

Nothing here is a fork. `scripts/extension-build.mjs` takes the ordinary web
build out of `web/dist`, puts a manifest around it, and writes one directory
per browser. The app notices where it is running by itself — `EXTENSION` in
`web/src/bridge.js` — and adjusts.

## Why an extension at all

The bridge exists because a web page may not call an endpoint that refuses
browser origins, and may not call plain `http` on loopback from an `https`
page. Neither is a fault in Ollama, or in llama.cpp, or in a company proxy;
both are rules the browser applies to pages.

An extension page is not a page in that sense. It can carry host permissions,
and with one for a given host it calls that host directly, CORS or no CORS. The
bridge is therefore off by default here, and a normal install never needs it
installed or left running.

Off by default, not gone. Two things still reach past it:

- A local MCP server means starting a program on this machine, which no
  extension may do. That is the bridge's job either way.
- An endpoint may refuse the extension by name rather than by CORS — see
  *Not sending an Origin* below — and if the rule that prevents that is not in
  force, every message fails with a 403. The bridge goes around it, so an
  enabled bridge here carries provider calls too rather than being ignored.

Which is why Settings → CORS bypass is still there, still works, and does not
claim to be unnecessary.

## Permissions

Nothing broad is asked for on install. `host_permissions` is empty and
`optional_host_permissions` is `<all_urls>`, so the browser shows no "read and
change all your data on all websites" on the way in, and the extension starts
out reaching only what CORS already lets any page reach.

That is further than it sounds. A provider that answers with CORS headers —
OpenAI, Anthropic, OpenRouter, Groq, the HuggingFace downloads WebLLM makes,
the bridge itself — needs no permission at all. Host access buys something only
where the endpoint refuses browser origins: Ollama, LM Studio, llama.cpp, a
server someone runs themselves. `web/src/host-access.js` asks for those one host
at a time, on the click that introduces them — Settings → Providers → Allow
access, or the row above the local scan.

One thing to know about the granularity: a match pattern carries no port, so
allowing `http://localhost:11434` allows every port on `localhost`. The UI says
so rather than implying otherwise.

| permission | what for |
| --- | --- |
| `optional_host_permissions: <all_urls>` | the pool the per-host grants come out of; the endpoint is the user's to choose and cannot be enumerated here |
| `sidePanel` (Chrome) | the app's only UI; Firefox uses `sidebar_action`, which needs none, and Safari has neither |
| `declarativeNetRequestWithHostAccess` (Chrome, Safari) | one rule, removing `Origin` from this extension's own requests — see below. The `WithHostAccess` spelling modifies only hosts already granted, and carries no install warning of its own |
| `webRequest`, `webRequestBlocking` (Firefox) | the same rule, the only way Firefox will apply it to an extension's own requests |
| `scripting` | registering the page-tools content script at runtime, for the sites you allowed and no others — and reading a mentioned page. No install warning |
| `storage` | three small things the page end needs and cannot ask the app for: which sites are allowed, the agent names its picker offers, and a request waiting for the panel to open. No install warning |
| `identity` | signing in to an MCP server that uses OAuth. No authorization server will redirect to `chrome-extension://`, and `identity.launchWebAuthFlow` supplies an https address on the browser's own domain instead. Optional on Chrome and Safari, so it is asked for on the click that needs it and an install that never connects such a server is never asked; required on Firefox, which drops it from `optional_permissions` rather than honouring it. No install warning either way |

Note what is *not* there: no `tabs`. Listing the tabs an `@` mention can name
uses `tabs.query`, which any extension may call — the browser withholds the
title and address of every tab you have not granted a host for, so the list is
exactly the allowed sites and the permission that shows on install as "read
your browsing history" is never asked for.

`npm run ext:test` checks the model from both ends: that a CORS-less endpoint is
out of reach before the grant, and in reach after it. Firefox goes through the
real `permissions.request()`, off a click the browser counts as user input.
Chrome cannot — its optional-permission prompt is a browser dialog no script can
answer, and the CDP Extensions domain grants nothing — so there the granted
state is reproduced by declaring the host and reloading. What that leaves
untested on Chrome is Chrome's own dialog.

## Building

```sh
npm run ext:build              # all three, into build/
npm run ext:build chrome       # just one
npm run ext:test               # install into real Chrome and Firefox, check it
npm run ext:safari             # generate and build the Safari app
```

`build/` is disposable and git-ignores itself; so does the Xcode project under
`packaging/safari`. Both are regenerated from `web/dist` every time.

## Publishing

Tagging a release builds the Chrome and Firefox zips, attaches both to the
GitHub release, and submits each to its store for review: the Chrome Web Store
and addons.mozilla.org. Safari is not in that job: what it installs is an app, and only Xcode on
a Mac can produce one.

Submitting is not going live. The store reviews it, in anywhere from an hour to
a week, and decides.

### The first version goes up by hand

The API replaces the draft of an item that already exists; it cannot write a
listing. So upload `ivxai-chat-<version>-chrome.zip` at
[the developer dashboard](https://chrome.google.com/webstore/devconsole) once,
fill in the description, screenshots and privacy answers, and publish it. The
32 letters in that item's dashboard URL are its id, and every later version is
the workflow's job.

### Setting up the credentials, once

The workflow signs in as a Google Cloud service account: a machine identity,
so there is no consent screen to click through and no refresh token to expire.
It goes through the store's v2 API, which is the only one left after v1.1 stops
answering on 15 October 2026.

In [console.cloud.google.com](https://console.cloud.google.com), on any project:

1. **APIs & Services → Library** → enable **Chrome Web Store API**.
2. **IAM & Admin → Service Accounts → Create service account.** It needs no
   roles.
3. On that account, **Keys → Add key → Create new key → JSON**. A file
   downloads.

Then in [the developer dashboard](https://chrome.google.com/webstore/devconsole),
under **Account**, add the service account's email (the `client_email` in that
file). The store takes one service account per publisher. On the
**Publisher → Settings** page, note the publisher id.

In **Settings → Secrets and variables → Actions**:

| secret | |
| --- | --- |
| `WEBSTORE_SERVICE_ACCOUNT` | the whole JSON file, pasted as it is |
| `WEBSTORE_PUBLISHER_ID` | from Publisher → Settings |
| `WEBSTORE_ITEM_ID` | the 32 letters in the item's store URL |

The key can publish to the store account on its own, and does not expire. Treat
it as the credential it is, and delete the downloaded file once it is in the
secret.

Without `WEBSTORE_SERVICE_ACCOUNT` the publish step is skipped and the release
still finishes with both zips attached, so a fork or a clone is never broken by
secrets it does not have.

### Publishing by hand

```sh
WEBSTORE_SERVICE_ACCOUNT=path/to/key.json WEBSTORE_PUBLISHER_ID=… WEBSTORE_ITEM_ID=… \
  npm run ext:publish -- packaging/extension/build/ivxai-chat-0.3.0-chrome.zip
```

Uploads as a draft. Add `--publish` to submit it, or `--publish --staged` to have
it held once approved rather than going live, until you publish it from the
dashboard. `WEBSTORE_SERVICE_ACCOUNT` takes a path here, or the JSON itself as
in the workflow.

### Firefox

The first version went up by hand, as on Chrome. After that it is
`scripts/amo-publish.mjs`, which needs an API key from addons.mozilla.org →
**Developer Hub → Manage API Keys**:

| secret | |
| --- | --- |
| `AMO_JWT_ISSUER` | the "JWT issuer", like `user:12345:678` |
| `AMO_JWT_SECRET` | the "JWT secret" |

The add-on is looked up by the gecko id in the manifest, `chat@ivx.run`, so the
listing has to carry that id. `AMO_ADDON_ID` overrides it if it ever does not.

Each version goes up with its source. The build bundles and minifies, and AMO
reviewers ask for the code behind anything they cannot read, so the script
attaches `git archive HEAD` — the whole repository at the commit being released
— with approval notes pointing reviewers at `AMO-REVIEW.md` in this directory,
which says how to rebuild the zip and diff it against the upload. Keep that file
true when the build changes.

There is no draft on AMO: creating a listed version is submitting it, and it
goes live once review passes it. To try the key without submitting anything:

```sh
npm run ext:build firefox
AMO_JWT_ISSUER=… AMO_JWT_SECRET=… npm run ext:publish:firefox -- \
  packaging/extension/build/ivxai-chat-0.3.0-firefox.zip --check
```

which uploads it, runs AMO's validator over it, and stops. Drop `--check` to
submit. `--source <zip>` sends a source archive of your own instead.

AMO never accepts a version number twice, even one that was deleted, so a
release that fails after the version was created needs a bump, not a retry.

## Installing it, by hand

**Chrome** — `chrome://extensions`, turn on Developer mode, *Load unpacked*,
choose `packaging/extension/build/chrome`.

Chrome no longer accepts `--load-extension` on the command line ("not allowed
in Google Chrome"), so this is the only way in by hand. `npm run ext:test`
gets around it with `Extensions.loadUnpacked` over the DevTools protocol.

**Firefox** — `about:debugging#/runtime/this-firefox`, *Load Temporary
Add-on*, choose `manifest.json` inside `packaging/extension/build/firefox`.
Temporary means it goes away when Firefox closes; a permanent install needs
the add-on signed by Mozilla.

**Safari** — Safari does not install a folder, it installs an app, and the
extension rides inside it:

```sh
npm run ext:safari
open packaging/safari/build/Build/Products/Release/ivxai-chat.app
```

Then, in Safari: *Settings → Extensions* and tick it. A build signed only
ad-hoc — which is what the command above produces, because we do not pay Apple
for a certificate — also needs *Develop → Allow Unsigned Extensions*, which
Safari forgets every time it quits.

## Page tools

Select text on a page and a small bar offers to **summarize** it, **translate**
it, or **ask an agent** about it; focus a text field and a chip offers to
**write with an agent**. Each one opens the panel on a fresh chat with the
request already in it, answered by the agent you picked or by the one the app
is already on.

It is off until you name a site. **Settings → Page tools** lists the sites it
runs on, and adding one goes through the browser's own permission prompt, out
of the same `<all_urls>` pool the provider grants come from. Removing a site
gives the permission back.

That is why `content.js` is shipped but is **not** in any manifest. A content
script declared there brings its host permissions with it, and for a tool that
could be used anywhere that is the "read and change all your data on all
websites" install warning — which would not even be true: nothing runs on a
site you have not named. `background.js` registers the script at runtime
instead, with `scripting.registerContentScripts`, for exactly the patterns the
browser has granted.

Writing into a field goes through a tool call rather than straight from the
reply. The model puts the text in a `<write>` block — the same shape as the
`<ask>` and `<tool>` blocks the chat already uses, and for the same reason: it
works on a provider with no function-calling at all. The block is parsed out
and only what was inside it reaches the field, so "Sure, here's a draft:" stays
in the chat instead of landing in somebody's outbox. `web/src/page-tools.js` is
the app's end of all of it.

Password fields get no chip. The chip carries the field's current contents up
to the chat so you can ask for a revision, which is right for a paragraph and
wrong for a password.

## Mentions, and reading a page

Type `@` in the composer to name an **open tab**, an **agent** or one of your
own **chats**. What you name goes into the message where you were typing, and
the thing itself is added to what the conversation carries — so "summarize it"
has an *it*, and still does two turns later.

Only tabs on allowed sites are listed. That is the same boundary as everything
else here, seen from the other side: with no site allowed there is nothing to
mention, and a host granted for a *provider* endpoint does not put your other
tabs in the menu. `npm run ext:test` checks both.

Naming a tab is also what unlocks the two reading tools:

| block | what it does |
| --- | --- |
| `<snapshot tab="…">` | the page's HTML, with scripts, styles, inline handlers and framework `data-*` stripped out. A CSS selector inside the block narrows it to one part of the page |
| `<screenshot tab="…">` | a picture of what is on screen in that tab, which arrives as an ordinary image attachment on the tool's own result |

The permission says what the extension *may* read; the mention says what it
*does*. A model is never told it can read every allowed tab, because a model
told that goes and reads them.

Firefox can photograph a tab that is not in front. Chrome and Safari cannot —
`captureVisibleTab` means what it says — so the tab is brought forward for as
long as the shutter takes and then put back.

Anything a snapshot or screenshot returns is content from a web page, and the
prompt says so in as many words: it is data, not instructions, and a page that
asks the model to do something should be reported rather than obeyed. That is
not a guarantee — nothing at this layer is — but it is the difference between
a model that names the attempt and one that is surprised by it.

## What the manifests ask for

`<all_urls>`, `scripting` and `storage` for page tools, and per browser one
permission for dropping the `Origin` header (below) plus `sidePanel` on Chrome.
Nothing else: no `tabs`, no `web_accessible_resources`, and no content script
in the manifest — page tools registers one at runtime for the sites you
allowed, and nothing runs on any other page you visit.

`<all_urls>` is broad, and the narrower thing does not exist: the endpoint is
whichever one you typed. A provider you self-host, a runtime on a port only
you use, a gateway inside a company network — none of that can be listed ahead
of time, and an extension cannot widen its own host permissions later without
asking again from scratch.

## Where it opens

In a side panel, beside the page you are reading — which is three different
APIs with nothing in common but the idea.

| | how |
| --- | --- |
| Chrome | `side_panel`, plus the `sidePanel` permission. `setPanelBehavior({ openPanelOnActionClick: true })` makes the toolbar button open it, after which the click never reaches the extension. |
| Firefox | `sidebar_action`, unrelated and needing no permission. Firefox lists it in the sidebar menu itself; the toolbar button calls `sidebarAction.toggle()`. |
| Safari | No sidebar exists. `safari-web-extension-converter` rejects `sidebar_action`, `side_panel` and `sidePanel` alike, so the app opens in a tab. |

A popup would have been the closer shape for Safari, and worse: it closes the
moment you click away, which for a window you type into loses the message.

The app is the same page either way, and its narrow layout — the one phones
get — is what a panel shows.

## Not sending an Origin

Getting past CORS is only half of it, and the quieter half is the `Origin`
header. A browser attaches one to every cross-origin POST, from an extension
page as readily as from a web page, and a runtime that vets origins — Ollama
checking `OLLAMA_ORIGINS` — answers 403. Nothing is blocked by the browser
there: the request arrives and the server turns it down.

It hides well. A GET carries no Origin, so model lists load and the extension
looks like it works, right until the first message is sent.

So the extension removes the header from its own calls, which puts it where a
native client already is: `curl` and Ollama's own CLI send no Origin and are
trusted for it. The header exists to tell a server that some *other* website
caused this request. Nothing caused this one — the person installed the app and
typed the address.

| | how |
| --- | --- |
| Chrome, Safari | `declarativeNetRequest`, a session rule matching `initiatorDomains: [runtime.id]` |
| Firefox | `webRequest` + `webRequestBlocking`, matching on `originUrl`. Firefox has declarativeNetRequest but does not apply it to an extension's own requests; Safari is the mirror image and rejects `webRequestBlocking`. |

The scoping is the part that matters. Stripping `Origin` browser-wide would
take a real protection away from every site you visit, so both rules match only
requests this extension made. `npm run ext:test` checks that from both ends: the
extension's Origin is gone, and an ordinary page's is still there.

The rule is registered when `background.js` runs, and nothing guarantees that it
has: an MV3 background script starts for an event, and opening the side panel is
not one of them. A build loaded before this rule existed has the same problem
until the extension is reloaded by hand. Either way every POST fails with a 403
that reads like a rejected API key — so the app does not assume. At boot it asks
the background script (`ivx:origin-strip`) whether the header is being dropped,
which both answers the question and, being an event, starts the script that was
not running. The answer is what the 403 message and the CORS bypass screen are
written from.

Safari is the gap. It takes the same rule Chrome does, but nothing can drive
Safari to confirm it honours a `modifyHeaders` action — so on Safari, treat this
as untested, and expect an origin-checking endpoint to still want the bridge.

## What else differs per browser

|  | why |
| --- | --- |
| `background.service_worker` | Chrome and Safari |
| `background.scripts` | Firefox, which has no extension service worker |
| `browser_specific_settings.gecko.id` | Firefox wants a stable add-on id |
