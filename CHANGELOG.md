# Changelog

All notable changes to WrexrOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Reverse proxy with automatic Let's Encrypt certificates and secure remote access.
- Alert delivery backends (email, webhook, Pushover) and backup replication.
- Plugin marketplace and localization packs.

## [0.1.1] - 2026-11-22

### Fixed
- BIOS/legacy ISO boot: ship the Syslinux `menu.c32` and `vesamenu.c32` COM32 modules on the
  ISO. The 0.1.0 image contained the menu libraries but not the modules themselves, so
  ISOLINUX dropped to a `boot:` prompt with `Failed to load COM32 file menu.c32`.
- Builder image now installs `syslinux-common` so the menu modules can be copied into the
  binary overlay.

## [0.1.0] - 2026-11-21

First public release. The repository was initialized from an empty canonical repository and
this release establishes the full foundation.

### Added
- **Installer**: ISO/USB boot menu with standard, advanced and unattended JSON install
  paths; guided disk selection; ZFS/Btrfs/ext4; mirror/raidz/raidz2/raidz10; parity/data/cache
  disk roles; static IP/DNS, hostname, timezone, keyboard, root password/SSH keys, kernel
  options; `--dry-run`, JSON schema validation and examples.
- **Boot experience**: dynamic console banner showing management IP and `https://IP:8443`,
  first-boot TLS generation, kiosk-mode service.
- **Web UI**: responsive light/dark SPA with dashboard charts, VM/LXC manager (VNC, PCI/GPU
  passthrough, VLAN bridges, firewall, templates), parity array and dataset management,
  SMB/NFS/FTP share wizard with users/groups/ACLs, Docker app store with trusted custom
  repos, settings with validated raw config editing and backups, WebSSH terminal, onboarding
  wizard, role-aware widgets.
- **Backend**: dependency-free Node 24 TypeScript daemon with REST + WebSockets, TLS, scrypt
  passwords, TOTP, RBAC, API tokens, audit log, SQLite persistence, and demo mode with
  realistic seeded data.
- **CLI**: `wrexctl` with parity to the UI, JSON output, scoped tokens and WebSocket shell.
- **Updates**: GitHub release checker, SHA256/GPG verification, atomic update apply, stable
  and beta channels, systemd daily timer.
- **Operations**: alerts, scheduled backups/snapshots, replication prep, signed plugins,
  multi-node linking data model.
- **Documentation**: README, architecture, installation (standard + advanced), API contract,
  API examples, CLI, updates, security, roadmap, screenshots and third-party notices.
- **CI/CD**: GitHub Actions workflow running tests, building the SPA, building and checking
  the ISO, and publishing tagged releases with checksums.

### Fixed
- ISO builder restores executable bits after copying repository content into the chroot tree,
  so live-boot hooks and CLI helpers are executable in the image.
- Builder image installs `cpio`, required by live-build when assembling the Debian installer
  initrd; the tagged CI run previously failed with exit 127.
- CI removes the root-owned checksum file before regenerating it, so the release job can
  publish `SHA256SUMS` without a permission error.

### Security
- No default credentials; first boot requires explicit password or SSH key setup.
- Least-privilege daemon with systemd sandboxing and a narrow sudoers allowlist.
- Signed update verification; unsigned assets refused when a trust key is installed.

[Unreleased]: https://github.com/nikolajalbrechtsen/WrexrOS/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.1
[0.1.0]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.0
