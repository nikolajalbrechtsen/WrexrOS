# Changelog

All notable changes to WrexrOS are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned
- Reverse proxy with automatic Let's Encrypt certificates and secure remote access.
- Alert delivery backends (email, webhook, Pushover) and backup replication.
- Plugin marketplace and localization packs.

## [0.1.5] - 2026-11-22

### Changed
- The text installer now uses a responsive, capability-detected terminal UI. It detects terminal
  width, uses Unicode box drawing only on UTF-8 capable terminals, and falls back to clean ASCII
  on serial consoles, the Linux text console and non-UTF-8 locales.
- Added `--color`, `--no-color` and `WREXR_UI_COLOR` controls so the same installer produces a
  rich console or sanitized CI logs.
- The guided flow now shows a firmware/architecture banner, grouped setup sections, a numbered
  installation plan and progress steps. Disk tables, network choices and the final management URL
  are easier to scan on 80-column displays.
- Installations booted over a serial console now carry the detected `console=ttyS...` setting into
  the installed kernel and GRUB, while VGA/UEFI/BIOS systems keep the existing console behavior.

## [0.1.4] - 2026-11-22

### Fixed
- Standard and Advanced installs no longer abort immediately at the disk-selection prompt with
  `disk.sh: line 18: n: unbound variable`. The loop used `-n cur` inside Bash arithmetic, which
  Bash parses as unary minus on a variable named `n` and which fails under `set -u`.
- Release consistency checks now reject `-n` inside arithmetic expressions in installer shell
  code, so this class of failure cannot reach another image.

## [0.1.3] - 2026-11-22

### Fixed
- The live installer image no longer enables `wrexrd.service`, `wrexr-console.service`,
  `wrexr-banner.service` or `wrexr-updater.timer`. Those units belong to installed systems; the
  live root has no `wrexr` service account, persistent state or TLS certificate, so `wrexrd`
  failed repeatedly and printed an unusable `https://<unconfigured>:8443/` banner during a
  Standard or Advanced install.
- Docker's storage-driver probe is masked in the live image. The overlay-backed live root is not
  a valid Docker upperdir, which produced harmless but alarming `overlayfs: ... not supported as
  upperdir` kernel messages while the installer prompt was waiting.
- The live console now identifies itself as the installer instead of advertising a management URL
  that only exists after installation. Installed systems still show the management URL and clean
  login prompt.
- Release consistency checks now fail if appliance units are re-enabled in the live image or
  Docker is no longer masked there.

## [0.1.2] - 2026-11-22

### Fixed
- ISO install mode is now declared on every ISOLINUX and GRUB menu entry instead of being set
  globally in the image command line. Rescue, existing-system and live entries can no longer
  inherit an accidental auto-install default.
- The ISOLINUX help entry now boots a real kernel command line instead of being a text-only
  label that dropped firmware back to `boot:`.
- Management NIC detection now defaults to `auto` instead of `eth0`, covering Proxmox virtio,
  Intel and Realtek interfaces and avoiding a silent no-link install.
- Live-media paths use `/run/live/medium/wrexr/...`; local unattended configs and `.deb`
  packages are copied to private `0600` temporary files before use.
- RAID validation now requires three devices for `raidz1` and four for `raidz2`/`raidz10`,
  preventing invalid ZFS and mdadm arrays from being created.
- mdadm arrays are registered in the installed system after all arrays have been created, even
  when no separate data disks are present.
- The builder verifies BIOS and UEFI El Torito entries with patterns matching real
  `xorriso -report_el_torito plain` output.
- Node 24 is checksum-verified and embedded in the ISO and installed system, so native
  TypeScript execution works on Debian bookworm.
- CI publishes a `WrexrOS-<version>-linux-amd64.tar.gz` code bundle and includes both the ISO
  and bundle in `SHA256SUMS`; the in-place updater can now verify and install a real asset.
- CI checks that `VERSION`, manifests, CLI, backend fallbacks, screenshots and the release tag
  agree before publishing.
- Documentation now matches the shipped menus, updater arguments, verification workflow and
  Proxmox direct-ISO attach procedure.
- The live image now includes `parted` (for `partprobe`) and the installed system includes
  `efibootmgr`, so preflight and UEFI GRUB installation work on real BIOS/OVMF machines.
- Disk safety now follows loop-backed live media (Ventoy, `findiso`, PXE) to its parent disk, so
  the boot USB can no longer be offered as an installation target.
- All config-level disk-count, filesystem and parity checks run before the first destructive
  `sgdisk --zap-all`; invalid RAID layouts are rejected without erasing disks.
- `raid=single` is rejected for multi-disk root and storage pools instead of silently creating a
  stripe or ignoring disks.
- Preflight checks filesystem-specific tools only after the filesystem is known, so ext4 and
  btrfs configs no longer require ZFS binaries (or miss btrfs binaries).
- `wrexrd` now reads the installer-generated `/etc/wrexr/wrexrd.toml` via `WREXR_CONFIG`, and
  first boot writes the certificate to `/var/lib/wrexr/tls/` where the daemon actually looks.
- Unattended `network.firewall.allowTcp` now defaults to the configured `uiPort` (plus SSH),
  keeping custom management ports reachable.
- The dead “Boot existing system” menu entry was replaced with an honest live-shell entry.
- ISO builds no longer depend on the Nodesource apt repository; the pinned Node 24 runtime is
  downloaded directly and `xz-utils` is installed explicitly. CI now reports container build
  failures as visible annotations, and post-build verification accepts both uppercase and
  lowercase Debian EFI boot paths.
- The published `WrexrOS-0.1.2-amd64.iso` was verified over HTTP to contain all four boot modes,
  the required ISOLINUX menu modules, both firmware-aware GRUB menus, and the unattended
  configuration fallback on the image.

### Security
- A trust key installed at `/etc/wrexr/trusted-updates.gpg` still refuses unsigned updates.
- Detached signatures use `SHA256SUMS.asc` consistently across CI, docs and the updater.

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

[Unreleased]: https://github.com/nikolajalbrechtsen/WrexrOS/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.5
[0.1.4]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.4
[0.1.3]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.3
[0.1.2]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.2
[0.1.1]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.1
[0.1.0]: https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.0
