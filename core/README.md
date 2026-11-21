# WrexrOS core (backend)

Dependency-free Node 24 management daemon for WrexrOS. TypeScript files are run
directly with Node's native type stripping — there is no build step and there
are **no external npm dependencies**.

## Run

```powershell
# Demo mode (simulated hardware, no Linux commands needed)
$env:WREXR_DEMO_MODE = '1'
$env:WREXR_INSECURE_HTTP = '1'   # optional: plain HTTP for development
$env:WREXR_STATE_DIR = "$env:TEMP\wrexr"
node --experimental-strip-types src/index.ts

# npm equivalents (from core/)
npm start
npm run dev      # --watch
```

The daemon prints a banner such as
`WrexrOS management UI: https://192.168.1.10:8443`.
By default it generates a self-signed certificate with `openssl` in
`<stateDir>/tls/` and serves HTTPS on port 8443. If `openssl` is unavailable it
falls back to HTTP with a warning. The API lives under `/api/v1`; every response
uses `{ok:true,data}` or `{ok:false,error:{code,message,details}}`.

First boot: `GET /api/v1/auth/status` reports `setupRequired: true`. POST a
hostname, timezone and password to `/api/v1/auth/setup` to create the first
admin and receive a session token. **There is no default password.**

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `WREXR_PORT` | `8443` | Listen port |
| `WREXR_HOST` | `0.0.0.0` | Listen address |
| `WREXR_STATE_DIR` | `/var/lib/wrexr` (falls back to `os.tmpdir()/wrexr` if unwritable) | SQLite DB, TLS keys, backups |
| `WREXR_TLS_CERT` / `WREXR_TLS_KEY` | `<stateDir>/tls/cert.pem` / `key.pem` | Certificate paths |
| `WREXR_DEMO_MODE` | `0` | Simulated hosts, no privileged commands |
| `WREXR_INSECURE_HTTP` | `0` | Plain HTTP instead of TLS (development) |
| `WREXR_CHANNEL` | `stable` | Update channel |
| `WREXR_HOSTNAME` / `WREXR_TIMEZONE` | OS host / `UTC` | First-run defaults |
| `WREXR_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` (JSON to stdout) |
| `WREXR_CORS` | same as demo mode | Permissive CORS headers for development |
| `WREXR_TERMINAL_ENABLED` | `0` | Allow the `/ws/terminal` shell (never enable by default) |
| `WREXR_SESSION_TTL_HOURS` | `24` | Session lifetime |
| `WREXR_TEMPLATE_PUBLIC_KEY` / `WREXR_PLUGIN_PUBLIC_KEY` | empty | Ed25519/SLIPH-0010 public keys (PEM or base64 SPKI) for signed templates |
| `WREXR_UPDATE_REPO` | WrexrOS GitHub URL | Repository advertised by `/updates/repo` |

Values may also be supplied in `<stateDir>/config.json`; environment variables
take precedence.

## Tests

```powershell
npm test
# or directly:
node --experimental-strip-types --test tests/*.test.ts
```

Tests use isolated temporary state directories and demo mode; they never call
external commands or the network.

## WebSockets

`/ws/metrics` pushes `{type:'metrics',data:{...}}` every two seconds,
`/ws/events` broadcasts `{type:'event',data:{...}}`, and `/ws/terminal` accepts
`input`, `resize` and `close` messages. The WebSocket implementation is
RFC 6455 compatible and dependency-free.

## Security notes

- Passwords are hashed with scrypt and a random 16-byte salt; comparisons use
  constant-time primitives. Sessions and API tokens are stored as SHA-256 hashes.
- RBAC roles are `admin`, `operator` and `viewer` (read-only), plus custom roles
  with `domain:action` permissions. API token scopes can only narrow a user's
  permissions.
- Every mutating request writes an audit entry with actor, action, resource,
  result and source IP, plus an event. Privileged routes require `system:admin`
  or `settings:admin`.
- External commands run via `execFile` with strict command allowlists, argument
  arrays and timeouts. No user input is ever passed to a shell or `eval`.
- Samba configuration is only written on Linux outside demo mode. Releases are
  verified against GitHub; signed templates/plugins require configured public
  keys.
- The built SPA is served from `core/web/dist` (when present) with an SPA
  fallback; `/api/v1/openapi.json` and `/api/v1/openapi.json` alias
  `/openapi.json` describe the whole API.
