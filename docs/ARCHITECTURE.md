# WrexrOS architecture

This document describes the 0.1.4 design. It is intentionally concrete: paths, processes,
protocols and failure boundaries are specified so contributors can reason about the system
without guessing.

## 1. Product shape

WrexrOS is an **appliance**, not a general-purpose distribution. The boot path is:

```text
firmware → live ISO kernel → initramfs → live root → installer (once)
         → installed Debian root → wrexr-console.service → getty on tty1
         → wrexrd.service → browser UI on :8443
```

The console is deliberately quiet: `boot/wrexr-console.sh` writes the management URL into
`/etc/issue.d/10-wrexr.issue` before `getty`, so the login prompt is preceded by the IP and
port. Kiosk mode replaces the shell on tty1 with a read-only browser pointed at the
dashboard.

## 2. Components

| Component | Technology | Responsibility |
| --- | --- | --- |
| `wrexrd` | Node 24 + TypeScript, no runtime deps | REST/WebSocket API, auth, RBAC, audit, orchestration |
| `web` | TypeScript SPA compiled to ES modules | All administration, onboarding, charts, VNC/WebSSH |
| `wrexctl` | Node CLI | Same operations as UI, for scripts and SSH sessions |
| `installer` | Bash + Node JSON validator | Guided/advanced/unattended installation |
| `updater` | Node + Bash | Release check, verification, atomic update apply |
| OS packages | Debian bookworm | QEMU/KVM, LXC, Docker, Samba, ZFS, Btrfs, smartmontools, netplan, nftables |

### Why Node with no dependencies?

* One runtime on the appliance and on the developer machine (Node 24 strips TS natively).
* A small ISO and a small attack surface: no npm tree in the installed image.
* The daemon can be reviewed end-to-end; command execution is centralised in one helper.

## 3. Process and privilege model

```text
root (boot only)
 ├─ wrexr-console.service   writes /etc/issue.d, may start kiosk browser
 ├─ wrexrd.service          User=wrexr, Group=wrexr
 │    ├─ SQLite: /var/lib/wrexr/wrexr.db  (mode 0640)
 │    ├─ TLS key: /var/lib/wrexr/tls/key.pem  (mode 0600, group wrexr)
 │    └─ sudo helper calls (narrow allowlist, systemd/sudoers)
 └─ privileged helpers: virsh, lxc, docker, zpool, zfs, smartctl, smbcontrol, ip, netplan
```

`wrexrd` is never root. `systemd/00-wrexr.conf` grants only exact `execFile` targets with
fixed argument shapes. The daemon itself additionally allowlists commands and always uses
`execFile` with argument arrays, so user-controlled values cannot become shell syntax.

## 4. State and configuration

* `/etc/wrexr/wrexrd.toml` — daemon startup config (port, TLS paths, state dir, channel, repo),
  read via `WREXR_CONFIG`; settings changed in the UI are stored separately in `wrexr.db`.
* `/etc/wrexr/install-state.json` — installer decisions (disks, roles, filesystem, network).
* `/var/lib/wrexr/wrexr.db` — SQLite state: users, sessions, tokens, audit, events, VMs,
  containers, shares, ACLs, apps, repos, disks, array membership, datasets, snapshots,
  alerts, backups, plugins, cluster nodes, metric history.
* `/var/lib/wrexr/setup-complete` — first-boot sentinel. Absent → `/auth/status` reports
  `setupRequired: true`, and the UI opens the wizard.
* `/etc/samba/wrexr-shares.conf` — generated include for Samba (only written on real Linux).
* `/etc/netplan/99-wrexr.yaml` — generated network config (only written when applying).

The raw config editor validates before writing and stores a timestamped copy in
`/var/lib/wrexr/backups/config/` first.

## 5. API boundary

`docs/API_CONTRACT.md` is authoritative. The router:

1. Parses the envelope and normalises errors to `{ok:false,error:{code,message}}`.
2. Authenticates via Bearer token or session cookie.
3. Maps `GET` → `domain:read`, mutating methods → `domain:write`/`domain:action`.
4. Records every mutation in the audit table with actor, resource, timestamp and source IP.
5. Delegates to a service, which persists state and emits an event to `/ws/events`.

WebSockets:
* `/ws/metrics` — 2-second metric frames for dashboard charts.
* `/ws/events` — event stream shared by UI toasts and the audit view.
* `/ws/terminal` — WebSSH; spawns a shell through a narrow helper in production, simulated
  in demo mode. Input/resize/close frames are supported.

## 6. Service adapters

Services are the only place that touches external tools. Each adapter has a **demo branch**
and a **real branch**:

| Service | Real commands | Demo behaviour |
| --- | --- | --- |
| Virtualization | `virsh`, `lxc`, `qm`-style wrappers, `ip`, `lspci`, `iptables` | Seeded VMs/containers with simulated lifecycle |
| Storage | `zpool`, `zfs`, `btrfs`, `mdadm`, `smartctl`, `lsblk` | Seeded disks, parity sync progress, datasets |
| Sharing | `smbcontrol`, `exportfs`, `systemctl`, config writers | In-memory shares/ACLs |
| Apps | `docker`, `docker compose` | Catalog install/start/stop simulation |
| Network | `ip`, `netplan`, `nft` | Mock interfaces/bridges |
| Updates | GitHub Releases API, `gpg`, `tar`, `dpkg` | Cached release metadata |

Adapters must degrade gracefully: a missing binary returns a structured error, never a
crash, and the UI shows a warning instead of stale data.

## 7. Security boundaries

1. **Identity** — scrypt(password, random salt, N=2^15), timing-safe comparison, session
   expiry, optional TOTP (RFC 6238), scoped API tokens.
2. **Authorization** — roles `admin`, `operator`, `viewer` plus custom roles with granular
   `domain:action` permissions. A `viewer` token cannot mutate anything even if it calls
   the API directly.
3. **Transport** — TLS 1.2+ with generated self-signed cert by default; HSTS; secure
   cookies; reverse proxy integration for Let's Encrypt.
4. **Input** — JSON body size limit, schema-ish validation per endpoint, path traversal
   checks for static files and share paths, enum validation for actions.
5. **Auditability** — append-only audit log; events surface in UI and alerts.
6. **Updates** — SHA256 + optional detached GPG signature; atomic swap with rollback.

## 8. Data flow example — creating a VM

```text
UI (VM create form)
  → POST /api/v1/vms {name,type,cpu,memory,disk,iso}
  → router: auth + vm:write permission
  → virtualization.create(): validate, persist draft to SQLite
  → real: virsh define <generated XML>/lxc-create ; demo: seed running VM
  → audit.record('vm.create', 'vm/<id>')
  → event 'VM <name> created' → /ws/events → toast + dashboard event list
  → response {ok:true,data:vm}
```

## 9. Failure modes

* **No network at first boot** — banner shows link-local address and a warning; wizard still
  works locally.
* **Updater offline** — checker returns a structured `OFFLINE` error with last-known state;
  no update is attempted.
* **Disk command failure** — installer aborts with a rollback hint before any data is lost
  when possible; `--dry-run` exists for verification.
* **DB corruption** — daemon fails closed with a clear log message; restore from
  `/var/lib/wrexr/backups/`.

## 10. Roadmap boundaries

HA failover and multi-node clustering are prepared in the data model (`cluster_nodes`,
replication jobs) but not a 0.1.4 guarantee. See `docs/ROADMAP.md`.
