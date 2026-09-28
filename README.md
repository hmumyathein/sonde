# Sonde

A local-first API client — request builder, collections, environments, scripting
and tests — that runs in your browser and stores everything on your own disk.

*A sonde is an instrument you send out to take a reading and report back. Same idea.*

**No dependencies.** No `npm install`, no build step, no bundler. Node ≥ 18 and a
browser is the whole toolchain.

```bash
npm start
```

Then open <http://127.0.0.1:5173>.

## As a standalone app

```bash
npm run build:app
```

That writes `dist/Sonde.app` — a double-clickable macOS bundle with its own Dock
icon. Drag it to `/Applications` if you want it in Spotlight.

The window is **native**: a small Swift host (`native/main.swift`) owns an
`NSWindow` with a `WKWebView` and runs the node server as its child process.
That ownership is the point — the Dock icon activates the app, ⌘Tab finds it,
⌘Q quits it, and no browser is involved. The web view gets a real Edit menu (so
⌘C/⌘V work), a save panel for exports and response downloads, and an open panel
for the form-data file pickers.

The server's lifetime is tied to the app's from both directions: quitting
terminates it, and it also watches its own stdin for EOF, so a crash or a
force-quit can't leave an orphaned server holding a port.

No packaging framework and no dependencies — the icon is drawn pixel by pixel
and encoded as PNG with node's own `zlib`, and the bundle is assembled by hand.
About 500 KB, because the runtime is the node you already have and the renderer
is the system WebKit.

### If the native window can't be used

The build compiles the host, then runs it once with `--probe` to check it is
actually allowed to execute before committing the bundle to it. On managed Macs,
application-control software (CyberArk EPM, CrowdStrike and similar) may delete
a locally compiled, ad-hoc-signed binary the moment it runs — which would
otherwise look like the app silently doing nothing when double-clicked. If the
probe fails, the build says so and falls back to a launcher that opens a browser
window instead.

In that case the better route is your browser's **Install app** button (Chrome,
Edge, Brave — in the address bar while Sonde is open). Sonde ships a web app
manifest, so that produces a proper standalone window with the Sonde icon, its
own Dock entry that activates correctly, and no unsigned binary anywhere.

The bundled app keeps its workspace in
`~/Library/Application Support/Sonde/workspace.json`, separate from the `./data`
used by `npm start` — so a bundle sitting in a read-only `/Applications` still
works. **The two run modes therefore have separate workspaces.** Copy one over
the other if you want them to match.

Node isn't on the PATH that Finder gives an app, so the launcher looks in the
usual install locations, including nvm, fnm and Volta version directories. If it
can't find node it says so in a dialog rather than failing silently. Its output
goes to `~/Library/Application Support/Sonde/sonde.log`.

Without the bundle, `npm run app` does the same thing from a terminal on any
platform. Sonde also ships a web app manifest, so any Chromium browser can
install it as a standalone window from the address bar.

---

## Why there's a server

A browser can't issue arbitrary cross-origin requests with custom headers — CORS
forbids it, which is precisely why Postman ships as a native app. So `server.js`
does two things: serves the UI, and performs the actual HTTP call on your behalf.

Running the request in Node rather than the browser also buys real fidelity:
raw header order and duplicates, manual redirect control, per-request TLS
settings, and genuine connection-phase timings.

## Features

**Requests** — all common methods, query params synced to the URL bar, headers,
and five body modes (raw with JSON/XML/HTML/JS, `x-www-form-urlencoded`,
`form-data` with real file uploads, and binary). The raw body editor is
syntax-coloured, using the same mirror-layer trick as the URL bar so native
editing still works.

**Auth** — Bearer, Basic, and API key (header or query), each inheritable from
the parent collection.

**Variables** — `{{name}}` anywhere: URL, headers, body, auth, scripts. Resolved
environment → collection → globals, with nested references. In the URL bar each
`{{name}}` gets a coloured chip — green when it resolves, red when nothing
defines it — drawn on a mirror layer behind a real `<input>`, so the caret,
selection and native editing are untouched. Focus or hover the URL bar and a
panel shows the address it actually resolves to, plus every
variable it references with its value and the scope that supplied it — so a
wrong `{{baseUrl}}` is visible before you send rather than after. Undefined
names are flagged in red. Dynamic values (`{{$guid}}`, `{{$timestamp}}`,
`{{$isoTimestamp}}`, `{{$randomInt}}`) are generated per send.

**Scripting and tests** — pre-request and test scripts with a Postman-shaped
`pm` API: `pm.test`, `pm.expect` (a chai-flavoured assertion set including
`.not`), `pm.response.to.have.status/header/jsonBody`, `pm.request.headers
.add/upsert/remove`, and `pm.environment.set`. Async tests are awaited.
`console.log` output lands in the Console tab.

**Responses** — pretty/raw/preview views with syntax highlighting (raw is
unformatted, not uncoloured), headers,
test results, a per-phase timing breakdown (DNS, TCP, TLS, TTFB, download),
redirect chains, image previews, and download for binary payloads.

**Organisation** — collections with nested folders, multiple open tabs with
dirty-state tracking, history, and import/export in
[Postman Collection v2.1](https://schema.getpostman.com/json/collection/v2.1.0/collection.json)
format, so collections move to and from Postman itself.

**OpenAPI import** — point it at a spec URL and it builds a collection.
OpenAPI 3.x and Swagger 2.0, in JSON or YAML, from a URL, a file, or pasted in.
`$ref`s and `allOf` are resolved to generate example request bodies; path
parameters become `{{variables}}`; required query parameters and headers arrive
switched on, with optional ones listed but unticked; and the spec's security
scheme is mapped onto the collection's auth. The server URL becomes
`{{baseUrl}}` in a matching environment — relative server URLs (`/api/v3`) are
resolved against the address the spec was fetched from.

Spec URLs are fetched through the proxy, so CORS doesn't get in the way.

Two import options control the shape of the result, and both are remembered:

| Folders by | |
| --- | --- |
| `Tags` | A folder per tag, from each operation's first tag. Untagged operations sit at the top level. *(default)* |
| `Path segments` | Folders mirror the URL hierarchy — `/store/order` becomes `store ▸ order`. Templated segments like `{orderId}` are skipped, so `/pet` and `/pet/{petId}` stay together. |
| `Don't group` | Every operation at the top level, in spec order. |

| Name requests by | |
| --- | --- |
| `Fallback` | First of `summary`, `operationId`, `description`, then the path. *(default)* |
| `Summary` | “Find pet by ID” |
| `Operation ID` | “getPetById” |
| `Description` | Trimmed to its first line |
| `URL` | “/pet/{petId}” — the method already shows beside it |

Every naming choice still falls back to the other fields when an operation
doesn't define the one you picked, so no request ends up nameless. Long names
are trimmed to fit the sidebar.

Tags are optional in OpenAPI and plenty of specs omit them entirely — that's
what `Path segments` is for.

**Code generation** — cURL, JavaScript `fetch`, Python `requests`, Go
`net/http`, and HTTPie, with variables already resolved.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `⌘/Ctrl + Enter` | Send |
| `⌘/Ctrl + S` | Save request |
| `⌘/Ctrl + T` | New tab |
| `⌘/Ctrl + W` | Close tab |
| `⌘/Ctrl + L` | Focus URL bar |
| `⌘/Ctrl + K` | Focus sidebar filter |

## Where your data lives

Everything is written to `data/workspace.json` — collections, environments,
history, and open tabs. It's plain JSON: diff it, commit it, or edit it by hand.
Writes are atomic (temp file + rename), and `localStorage` acts as a fallback if
the server is unreachable. Response bodies are never persisted.

## Layout

```
server.js              static file serving + /api/send proxy + workspace storage
native/
  main.swift           native macOS host: NSWindow + WKWebView + server child
scripts/
  make-app.mjs         builds and signs dist/Sonde.app
  make-icons.mjs       draws the icon and encodes PNGs, no image library
public/
  index.html           app shell
  manifest.webmanifest installable-web-app metadata
  icons/               generated app icons
  css/styles.css       theming tokens, dark and light
  js/
    main.js            bootstrap, tab strip, send/save, shortcuts, layout
    store.js           application state and persistence
    model.js           data-model factories and defaults
    send.js            resolve → build → pre-request → send → test pipeline
    sandbox.js         the pm.* scripting API and assertion library
    vars.js            {{variable}} resolution
    request-panel.js   request editor tabs
    response-panel.js  response viewer tabs
    sidebar.js         collections, environments, history
    collection-io.js   Postman v2.1 import/export, format detection
    openapi.js         OpenAPI 3.x / Swagger 2.0 → collection
    yaml.js            small YAML parser (no dependencies, remember)
    codegen.js         snippet generators
    ui-common.js       key/value grids, modals, toasts
    highlight.js       JSON/XML highlighting
    utils.js           DOM and formatting helpers
```

## A note on scope

The proxy will fetch any URL it is given — that is what an API client is for.
It therefore binds to `127.0.0.1` and should stay there; don't expose it to a
network or run it as a shared service. Set `HOST`/`PORT` if you need to move it:

```bash
PORT=5174 npm start
```

The bundled YAML parser covers what OpenAPI documents actually use — block and
flow collections, block scalars, multi-line quoted and plain scalars,
zero-indented sequences, anchors, aliases and merge keys. It is not a
spec-complete YAML implementation: custom tags (`!!type`) and complex keys
(`? :`) will be reported as a parse error rather than silently mis-read.

Test scripts run via `new Function` in the page. That is not a sandbox — it's
your own code in your own browser, like a devtools snippet. It exists to provide
the `pm` API, not to contain untrusted scripts, so treat imported collections
with the same care you'd treat any script you're about to run.
