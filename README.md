# WrexrOS

**The self-hosted hypervisor + NAS appliance that boots straight into a browser.**

WrexrOS combines the installer, virtualisation and clean management surface of Proxmox VE
with the parity-protected storage, file sharing and Docker app store experience of Unraid.
It is a headless Debian-based appliance: the console shows one line — the URL of the
management UI — and everything else is done through a responsive web UI, a complete REST
API, or the `wrexctl` CLI.

> **Canonical repository:** <https://github.com/nikolajalbrechtsen/WrexrOS.git>
> All releases, issues and updates are synchronised with this repository.

| | |
| --- | --- |
| Version | `0.1.6` (see [CHANGELOG.md](CHANGELOG.md)) |
| License | MIT (see [LICENSE](LICENSE)) |
| Base | Debian 12 "bookworm", amd64 |
| Management UI | `https://<IP>:8443` (TLS by default) |
| Default user | **none** — first boot forces the setup wizard |

---

## What works in 0.1.6

* **Appliance boot** — dynamic console banner with management IP + UI port, kiosk option,
  idempotent first-boot service.
* **Installer** — ISO/USB with *Standard* and *Advanced* guided paths plus unattended JSON
  installs. Advanced covers manual partitioning, ZFS/Btrfs/ext4, RAID levels, parity/data
  roles, static IP/DNS, hostname, timezone, keyboard, root password/SSH keys and kernel
  options. `--dry-run` prints every destructive step before touching a disk.
* **Web UI** — dashboard with live CPU/RAM/disk/network charts, VM/LXC manager with VNC,
  PCI/GPU passthrough, VLAN-aware bridges and firewall rules; parity array and ZFS/Btrfs
  dataset management; SMB/NFS/FTP share wizard with users, groups and ACLs; Docker app
  store with catalog, trusted badges, custom repos and one-click install; full settings
  with validated raw config editing and automatic backups; WebSSH terminal; onboarding
  wizard. Responsive light/dark interface with role-aware widgets.
* **Backend** — dependency-free Node.js/TypeScript daemon, REST API + WebSockets, TLS,
  scrypt password hashing, TOTP, RBAC, API tokens, audit log, SQLite state, adapters for
  `virsh`, `lxc`, `docker`, `zfs`, `smartctl`, Samba, `ip`/netplan and more. A demo mode
  lets developers run the whole UI without hypervisor hardware.
* **`wrexctl`** — command-line parity with the UI for scripting and automation.
* **Live updates** — built-in release checker talking to the canonical GitHub repo,
  SHA256 + optional GPG signature verification, stable/beta channels, systemd timer.
* **Operations** — alerts (email/webhook/Pushover), scheduled snapshots/backups and
  replication prep, signed plugin framework, multi-node linking / HA prep.
* **CI/CD** — GitHub Actions runs tests, builds the web bundle, builds an ISO and publishes
  release assets with checksums and optional GPG signatures.

See [docs/ROADMAP.md](docs/ROADMAP.md) for stretch goals (HA failover, clustering, kiosk
extensions, plugin marketplace) and what is intentionally out of scope for 0.1.6.

---

## Quick start (ISO)

1. Download `WrexrOS-<version>-amd64.iso` and matching `SHA256SUMS` from the
   [Releases page](https://github.com/nikolajalbrechtsen/WrexrOS/releases).
2. Verify: `sha256sum -c SHA256SUMS`.
3. Write to a USB stick (`dd if=WrexrOS-*.iso of=/dev/sdX bs=4M status=progress`) or attach
   it to a VM.
4. Boot and select **Standard install** (guided) or **Advanced install** (expert).
5. Reboot. The console prints:

   ```text
   WrexrOS 0.1.6
   https://192.168.1.24:8443

   wrexros login:
   ```

6. Open the URL, complete the first-run wizard (hostname, timezone, network, root
   password/SSH key), then create your first share or VM.

Full instructions: [docs/INSTALL.md](docs/INSTALL.md) and
[docs/ADVANCED_INSTALL.md](docs/ADVANCED_INSTALL.md).

### Unattended install

```bash
sudo /opt/wrexr/installer/wrexr-installer.sh --config /mnt/usb/install.json --yes
```

Example configs live in `installer/examples/`. Validate one without installing:

```bash
node installer/validate-config.mjs installer/examples/unattended-zfs-raid.json
```

---

## Local development (no Linux hardware required)

Node.js 24+ is the only host requirement for development. The backend runs TypeScript
directly; the UI builds to plain ES modules with a dependency-free build script.

```bash
# Terminal 1 — API in demo mode
WREXR_DEMO_MODE=1 WREXR_INSECURE_HTTP=1 node --experimental-strip-types core/src/index.ts

# Terminal 2 — web dev server (proxies /api and /ws to :8443)
cd web && node dev-server.mjs

# Tests
node --test core/tests/*.test.ts
node --experimental-strip-types cli/tests/wrexctl.test.ts
node web/build.mjs
```

Open <http://localhost:5173>. Demo mode seeds realistic VMs, disks, shares, apps and
events so every screen is functional. Set a real password through the wizard before using
it anywhere else. See [docs/DEMO.md](docs/DEMO.md) for details and reset instructions.

> On Windows, `npm` is not needed — the build scripts use only Node built-ins.

---

## Repository layout

```text
core/           REST + WebSocket daemon, services, RBAC, SQLite state, tests
web/            Dependency-free TypeScript SPA and its build/dev servers
cli/            wrexctl CLI and minimal WebSocket client
installer/      Guided + unattended installer and JSON schema
boot/           Console banner, first-boot and kiosk helpers
systemd/        Hardened service units and sudoers drop-in
updater/        Release checker, signature verification and updater
catalog/        Built-in and example custom Docker app templates
packaging/      Dockerfile, live-build config and ISO builder
docs/           Architecture, install, API, CLI, security, roadmap
screenshots/    Reference renders of the UI
.github/        CI/CD workflow
```

---

## Architecture at a glance

```text
 Browser ──TLS──> web/dist SPA ──REST/WS──> wrexrd (Node, :8443)
                                              │
                     ┌────────────────────────┼────────────────────────┐
                     ▼                        ▼                        ▼
              libvirt / LXC              ZFS / Btrfs / parity      Docker Engine
              virsh, VNC bridge          zpool, smartctl, mdadm    docker CLI/API
                     │                        │                        │
                     └────────── SQLite state + audit log + RBAC ─────┘
                                              │
                              Samba / NFS / FTP / netplan / nftables
```

The daemon never runs as root; privileged operations go through a small, audited helper
allowlist. Full design notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## API and CLI

* REST contract and examples: [docs/API.md](docs/API.md), machine-readable route table at
  `GET /api/v1/openapi.json`.
* CLI reference: [docs/CLI.md](docs/CLI.md) and `cli/README.md`.

```bash
wrexctl status
wrexctl vm create --name win11 --type kvm --cpu 4 --memory 8192 --disk 80
wrexctl vm start win11
wrexctl share create --name media --path /mnt/array/media --protocol smb --recycle
wrexctl app install jellyfin
wrexctl update check --json
```

---

## Live updates

The Settings → Updates screen, `wrexctl update check`, and the daily systemd timer all use
the same checker:

```bash
node updater/check-update.mjs --channel stable --json
# { "current": "0.1.6", "latest": "0.1.6", "updateAvailable": false, ... }
```

Releases are created by CI with attached ISO, `SHA256SUMS`, and an optional detached GPG
signature. The updater refuses unsigned assets when `/etc/wrexr/trusted-updates.gpg` is
present. Details: [docs/UPDATES.md](docs/UPDATES.md).

---

## Contributing

1. Fork or branch from the canonical repository.
2. Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the API contract.
3. Keep changes dependency-free where practical; add tests for new endpoints.
4. Run the test suite and ISO build check before opening a PR.
5. Update `CHANGELOG.md` under **Unreleased** and bump `VERSION` only in release commits.

Code of conduct: be respectful, assume good intent, and prefer reproducible bug reports.

---

## Screenshots

See [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md) and the `screenshots/` directory.

---

## Trademarks

Proxmox VE, Unraid, Debian, QEMU, KVM, LXC, Docker, Samba, ZFS and Btrfs are trademarks or
registered trademarks of their respective owners. WrexrOS is an independent project and is
not affiliated with them.
