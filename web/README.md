# ivx/ai Chat

ivx/ai Chat is a lightweight, browser-based chat client designed for users who
want total control over their data and their AI interactions. It has no backend,
no accounts, no analytics and zero telemetry: a pure frontend that talks to your
chosen model directly, so your conversations and API keys never pass through a
third party server and stay entirely within your browser.

<p align="center">
  <img src="demo.png" alt="ivx/ai Chat with a new conversation open" width="820">
</p>

<p align="center">
  <a href="https://ai.ivx.run/chat">Try it</a> ·
  <a href="https://github.com/ivxlabs/ivxai-app/releases/latest">Download</a> ·
  <a href="https://ai.ivx.run/docs/">Help</a> ·
  <a href="LICENSE">GPL-3.0-or-later</a>
</p>

This folder is the app itself. The installable versions and the helper that
reaches models on your own computer are at the
[root of this repository](../README.md).

## Nobody in the middle

Most chat apps keep your conversations on their servers, count what you do with
them, and train on them. ivx/ai Chat has no server to keep anything on.

- **No account.** Nothing to sign up for, nothing to log in to.
- **Nothing is collected.** No tracking, no ads, no usage reports.
- **Your chats stay on your device**, along with your keys, which you can lock
  behind a passphrase.
- **Nothing else is loaded.** No outside code, fonts or trackers.

Your messages do go to whichever AI service you pick, which no app can change.
Choose one you trust, or run a model on your own computer and skip that too.

### The detailed version

Halfmoon CSS, IBM Plex, highlight.js, Remix Icon and WebLLM are bundled into the
build and served from your own address.

A Content-Security-Policy of `script-src 'self' 'wasm-unsafe-eval'` blocks code
from anywhere else, and `eval()` with it. The second source is there so an
in-browser model can compile its WebAssembly.

Conversations, messages and keys live in IndexedDB. Open the Network panel and
the only calls are chat completions and model lists, to the address you set.

Three switches can add to that: an in-browser model downloads its weights from
HuggingFace once, the Store fetches its catalogue while open, and an MCP server
is asked for its tools.

The publish workflow fails the build if any other outside address shows up.

## Connecting a model

Open **Settings → Providers**. WebLLM, Ollama, LM Studio and OpenRouter are
there already; add others from the list, or point "Custom OpenAI-compatible" at
anything that speaks the OpenAI chat format. Paste a key, then **Fetch models**.

WebLLM needs nothing at all: the model runs inside this browser, so you can chat
before setting anything up. Most other services need the helper below.

| Service | Address | Key |
| --- | --- | --- |
| WebLLM | none, runs in this browser | not needed |
| Ollama | `http://localhost:11434` | not needed |
| LM Studio | `http://localhost:1234/v1` | not needed |
| llama.cpp | `http://localhost:8080/v1` | not needed |
| Jan · vLLM · LocalAI · Text generation WebUI | see the list | not needed |
| OpenRouter | `https://openrouter.ai/api/v1` | openrouter.ai/keys |
| OpenAI | `https://api.openai.com/v1` | required |
| Anthropic | `https://api.anthropic.com` | required |
| Groq · Mistral · Together · DeepSeek | see the list | required |

**Scan for local servers** finds whichever of these is already running on your
machine.

If a service does not publish a model list, choose **Type a model name**
instead. Names you type are remembered.

## The helper: ivxai-bridge

Browsers do not let a web page talk to programs on your own computer, and many
online services refuse calls that come from a web page. Without the helper,
only the in-browser model is guaranteed to work.

A couple of cases can be fixed at the source instead:

- **Ollama** turns them down by default. Start it as
  `OLLAMA_ORIGINS='http://localhost:5173' ollama serve`
- **Anthropic** needs an extra header, which the app sends for you. A key used
  in a browser can be seen by anyone using that browser.

For everything else, run the helper that comes with the installable apps:

```sh
ivxai-bridge
```

Then **Settings → CORS bypass → Look for the bridge**. It is off until you turn
it on, stores nothing, and only answers ivx/ai Chat. The installable versions
carry it inside them already.

More: [The bridge](https://ai.ivx.run/docs/bridge/).

## Agents, tools and the Store

An **agent** is a model saved with a name, a prompt and its settings. You get
one per service to begin with.

Chats point at an agent rather than copying it, so changing the agent changes
every chat using it. An agent can also ask another agent for help mid-answer.

**Tools** come from MCP servers. Remote ones are called over the web; one that
runs as a program on your own machine goes through the bridge, since a browser
cannot start a program. You choose which agents get which tools.

A hosted MCP server that signs you in rather than handing you a token — Notion,
Linear and most of the others — is added by pasting the same one-line config
its own setup page shows you, and then pressing **Sign in**. A window opens, you
approve it there, and the token comes back here. This app registers itself with
that server at that moment, from your browser: there is no developer account of
ours in the middle, because there is nothing of ours in the middle of anything.
The token is kept with your API keys — encrypted at rest as soon as you set a
passphrase — and refreshes itself. A server that issues tokens by hand still
takes one in the Bearer token field.

The **Store** installs services, agents, tools and skills that other people have
written down. Entries are settings, never code, and installing one still asks
first.

## Keys

Keys sit in your browser's storage as plain text unless you turn on **Settings →
Privacy & data → Encrypt API keys**.

That locks them with a passphrase (AES-GCM, PBKDF2-SHA256, 310 000 iterations),
kept in memory only: unlock once per session, re-lock from the sidebar. Forget
the passphrase and the keys are gone, with no way back.

## What else it does

- **Settings per chat**: its own prompt, creativity, length limit and how much
  history to send.
- **Message actions**: copy, edit and run again from that point, retry, delete.
- **Chat actions**: rename, duplicate, archive, save as a file.
- **Right-click anything**: a message, a code block, a link, an attachment, a
  chat in the list — the menu holds what that one thing can do. Holding Shift
  gets the browser's own menu back, and anywhere you type keeps it anyway, so
  spelling suggestions and paste are never taken away.
- **Share link**: the chat travels inside the link itself, so no server holds a
  copy.
- **Backup**: export everything, keys included only if you tick the box.
- **Search** your chat titles and messages.
- **Erase everything**, including the offline copy.

## For developers

```sh
npm install
npm run dev        # http://localhost:5173
npm run mock       # a fake OpenAI-compatible API on :8124
npm run check      # a name used but never imported
```

For the real thing, including the service worker and offline mode:

```sh
npm run build      # -> dist/
npm run preview    # http://localhost:4173
```

`dist/` is plain static files with a relative base, so it drops into any host or
subdirectory; see [Self-hosting](https://ai.ivx.run/docs/self-hosting/).

Each file says what it is for at the top, and the traps are noted where they
are: `public/sw.js`, the precache plugin in `vite.config.js`, the Halfmoon class
namespace in `src/styles/app.css`, the sheet stack in `src/ui.js`.

The bridge, the desktop and mobile apps and the release process:
[Building it](https://ai.ivx.run/docs/building/).

To check a build the way Pages serves it, from a subpath:

```sh
npm run build
mkdir -p /tmp/pages/chat && cp -R dist/* /tmp/pages/chat/
cd /tmp/pages && python3 -m http.server 8125
# http://localhost:8125/chat/
```

[ai.ivx.run/chat](https://ai.ivx.run/chat) is built from this folder by the
publish workflow in
[ivxlabs/ivxlabs.github.io](https://github.com/ivxlabs/ivxlabs.github.io): build
`dist/`, check it, serve it at `/chat`.

## Supporting it

- [Sponsor the project](https://github.com/sponsors/0xcrypto)
- [Star it on GitHub](https://github.com/ivxlabs/ivxai-app)

## Licence

Free software under the **GNU GPL v3.0 or later**, see [LICENSE](LICENSE).

Bundled dependencies keep their own terms: Halfmoon CSS is MIT, © 2023 Tahmid
Khan; IBM Plex is SIL OFL; highlight.js is BSD-3-Clause; Remix Icon and WebLLM
are Apache-2.0; Vite is MIT.
