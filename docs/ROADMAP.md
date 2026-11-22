# Roadmap

## 0.1.4 — Foundation (current)

Delivered in the first release:

- Guided/unattended installer with ZFS/Btrfs/ext4, RAID and parity roles.
- Headless boot banner with management URL.
- Dashboard, VM/LXC manager, VNC, PCI passthrough, bridges, firewall.
- Parity array, ZFS/Btrfs datasets, SMART, SMB/NFS/FTP shares, ACLs.
- Docker app store with catalog, custom repos and signed templates.
- Settings, RBAC, 2FA, API tokens, audit log, WebSSH, `wrexctl`, REST/WS API.
- Release checker, signed updates, CI-built ISO.

## 0.2.0 — Hardening and convenience

- [ ] Reverse proxy UI with automatic Let's Encrypt certificates and secure remote access
      (TR-007 style tunnel; no manual port forwarding).
- [ ] Email/webhook/Pushover alert delivery backends with threshold tuning UI.
- [ ] Scheduled VM backup to array/external storage with retention policies.
- [ ] One-click replication to a second WrexrOS node.
- [ ] Plugin marketplace with signature verification and dependency resolution.
- [ ] Boot-to-UI kiosk polish (read-only dashboard, auto-rotate, remote wake).
- [ ] Localization: Danish, German, French, Spanish UI packs.

## 0.3.0 — Multi-node

- [ ] Shared management across nodes (stretch goal).
- [ ] HA VM failover with shared ZFS/iSCSI storage and fence agents.
- [ ] Cluster-aware scheduling and live migration prep.
- [ ] Distributed audit/events.

## Non-goals

* WrexrOS is not a desktop distribution; there is no general GUI session by default.
* We do not fork QEMU, Docker, Samba or ZFS; we integrate them.
* 0.1.4 does not guarantee production HA; treat clusters as experimental until 0.3.0.

Have a feature request? Open an issue on the canonical repository with a concrete use case.
