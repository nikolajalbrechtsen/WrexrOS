# Demo mode

Demo mode exists so contributors can exercise the entire WrexrOS UI and CLI on a laptop
without KVM, ZFS, Docker or Samba. It is enabled with `WREXR_DEMO_MODE=1` and never used by
the shipped appliance.

## Run the stack

```bash
# API (terminal 1)
WREXR_DEMO_MODE=1 WREXR_INSECURE_HTTP=1 node --experimental-strip-types core/src/index.ts

# Web UI (terminal 2)
node web/dev-server.mjs
```

Open <http://localhost:5173>. The wizard will ask for a password; choose any value — it is
stored only in your local demo state directory (`WREXR_STATE_DIR`, default a temp folder
outside the repository).

## What is simulated

| Feature | Demo behaviour |
| --- | --- |
| VMs / LXC | Seeded guests with start/stop/snapshot state transitions in SQLite |
| Storage | Six data disks, one parity disk, sync progress and SMART values |
| Shares | Full CRUD and ACLs; no Samba config is written |
| Apps | Built-in catalog, install/start/stop/upgrade simulation |
| WebSSH | Echo shell with a few sample commands (`help`, `status`, `wrexctl …`) |
| Updates | Calls the real GitHub API when reachable; falls back to a cached fixture |
| Metrics | Synthetic CPU/RAM/network data pushed every 2 seconds |

## Safety

Demo mode still enforces authentication, RBAC, TOTP and audit logging — only the external
tool adapters are replaced. Do not expose a demo instance to an untrusted network: it uses
`WREXR_INSECURE_HTTP` and an arbitrary password by design.

To reset, stop the daemon and delete the state directory:

```bash
rm -rf "$WREXR_STATE_DIR"
```
