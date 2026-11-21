# WrexrOS Web UI

A dependency-free single-page application for the WrexrOS hypervisor / NAS appliance.
It talks exclusively to the endpoints defined in `docs/API_CONTRACT.md` (base `/api/v1`,
WebSockets at `/api/v1/ws/*`).

## Requirements

- Node.js 24 or newer (for `module.stripTypeScriptTypes`).
- No npm install step — there are **zero** runtime or build dependencies.

## Build

```bash
cd web
npm run build          # or: node build.mjs
```

`build.mjs` resolves all paths relative to its own URL, so it works from any CWD:

```bash
node /path/to/web/build.mjs
```

The build walks `src/**/*.ts`, strips TypeScript syntax with `node:module`'s
`stripTypeScriptTypes`, rewrites authored `.ts` import specifiers to `.js`, and writes
ES modules to `dist/**/*.js`. It then copies `index.html`, `styles.css` and
`src/logo.svg` into `dist/`.

## Run

```bash
npm run dev            # static dist/ on :5173, SPA fallback, permissive CORS
npm run preview        # same server
```

The dev server proxies `/api` and `/ws` to `http://127.0.0.1:8443` by default. Point it
somewhere else with:

```bash
WREXR_API=http://127.0.0.1:8443 npm run dev
PORT=3000 npm run dev
```

For production, serve `dist/` with any static host that falls back to `index.html` for
client-side routes, and let the reverse proxy forward `/api` and `/ws` to the daemon.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/dom.ts` | Tiny keyed virtual-DOM renderer, `h()`, `Fragment`, events, class/style handling, `useState` signals, trusted raw-SVG escape hatch. |
| `src/api.ts` | Typed fetch client with `{ ok, data }` envelope handling, Bearer token storage, reconnecting WebSocket helper, auth flow. |
| `src/types.ts` | Interfaces mirroring the API contract. |
| `src/store.ts` | Global app state, theme persistence, permission checks (`can()`), toast queue. |
| `src/components.ts` | Reusable UI kit (sidebar, topbar, cards, tables, charts, modals, editors, terminal…). |
| `src/pages/*.ts` | One module per frontend route; each exports `load()` and `View()`. |
| `src/app.ts` | History router, auth guard, theme application, global WS subscriptions, keyboard shortcuts. |
| `src/main.ts` | Entry point that calls `bootstrap()`; auth/status checks and routing live in `app.ts`. |

### Why a custom renderer?

The appliance ships a single self-contained binary. Adding React/Preact/Vite would mean
shipping a node_modules tree, a bundler and a license surface into the build image. A
~300-line keyed virtual DOM with signal-driven re-rendering is enough for this UI, works
in every modern browser, and lets the TypeScript sources be compiled by Node itself —
no external tooling, no lockfile, no supply-chain risk.

### Conventions

- Source imports use explicit `.ts` extensions; `build.mjs` rewrites them to `.js` so
  the emitted ES modules load natively in the browser.
- Only type-level TypeScript features supported by `stripTypeScriptTypes` are used
  (no enums, parameter properties, decorators or namespaces).
- Text is always rendered through DOM text nodes (auto-escaped). `rawSvg()` is the only
  `innerHTML` path and is reserved for static icon markup and numeric chart geometry.
- Routes use the History API; the dev server and production proxy must fall back to
  `index.html`.
- Role checks go through `can('domain:action')`; admins pass everything, viewers only
  read actions.
