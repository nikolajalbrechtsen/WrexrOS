# WrexrOS installer

`wrexr-installer.sh` installs a Debian `bookworm` base plus the WrexrOS stack
(libvirt/KVM, LXC, Docker, ZFS/Btrfs/mdadm, Samba/NFS/FTP, wrexrd and the web UI).
It is **destructive**: every disk assigned a role is wiped.

```bash
sudo bash installer/wrexr-installer.sh --help
sudo bash installer/wrexr-installer.sh --dry-run --yes \
  --config installer/examples/unattended-standard.json
```

## Terminal interface

The installer adapts to the console it is running on:

* VGA, noVNC, SSH and modern terminals get colours, box drawing, grouped sections and progress steps.
* Serial consoles, `TERM=linux`, non-UTF-8 locales and CI logs automatically get plain ASCII output.
* Terminal width is detected from `/dev/tty`, `COLUMNS` or `tput`; content is clipped to stay readable on 80-column displays.
* `--no-color` (or `NO_COLOR=1`, `WREXR_UI_COLOR=never`) forces plain output. `--color` forces rich output.
* UEFI and legacy BIOS are detected and shown in the banner. If installation media was booted with `console=ttyS...`, that console is carried into the installed kernel and GRUB.
* When `whiptail` and a real terminal are available, the guided flow uses a full-screen ncurses interface instead of line prompts. It includes menus, radiolists, input/password boxes, an installation-plan review, progress dialogs and a final completion dialog.
* `--tui` forces the full-screen interface and `--text` forces line prompts. `WREXR_TUI=always|never|auto` provides the same control through the environment. Serial/CI sessions without a usable terminal automatically stay in text mode.

## Interactive paths

Boot the ISO and run `sudo /opt/wrexr/installer/wrexr-installer.sh --interactive --advanced`,
or choose *Standard install* / *Advanced install* from the ISO menu.

### Standard install (defaults)

* Enumerates disks with `lsblk`, sorted by size.
* Picks the smallest disk with at least 32 GiB as the **system** disk; all other
  disks become **data** disks. Two or more data disks use a ZFS mirror by default.
* Partitions: 512 MiB EFI (EF00), 1 MiB BIOS boot (EF02), optional 4 GiB swap,
  root on the remainder.
* Filesystem ZFS (root pool `lz4`, storage pool `zstd`), DHCP on the auto-detected
  management NIC via bridge `br0`, timezone UTC, keyboard `us`, management port 8443,
  firewall allowing SSH + HTTPS.
* Prompts for a root password **or** an SSH public key, then for a final
  `WIPE MY DISKS` confirmation (skipped with `--yes`).

### Advanced options

Manual disk selection with roles `system`, `parity`, `data`, `cache`; filesystem
`zfs` / `btrfs` / `ext4`; RAID `single`, `mirror`, `raidz1`, `raidz2`, `raidz10`;
static IPv4 (address/netmask/gateway/DNS) or DHCP; hostname, keyboard, timezone,
UI port; root password or SSH key; extra kernel options; additional users and
shares (`name:protocol:path`). All answers are validated with the same JSON schema
as unattended installs before anything is written.

Role notes:
* `system` disks hold the root pool. Multiple system disks form a mirror (or
  btrfs RAID1 / mdadm RAID1 for non-ZFS filesystems).
* `parity` and `data` disks form the storage pool. With ZFS, `raidz1`/`raidz2`
  include parity members in the raidz group; with btrfs/ext4 they are mapped to
  RAID5/RAID6 or RAID1/RAID10 via mdadm.
* `cache` disks become ZFS L2ARC devices; with btrfs/ext4 they are reported as
  unused (a warning is printed).

## Unattended installs

Validate a config first:

```bash
chmod 600 my-config.json
node installer/validate-config.mjs my-config.json --print-defaults
```

Then install (unattended mode requires **both** `force: true` in the config and
`--yes` on the command line):

```bash
sudo bash installer/wrexr-installer.sh --config my-config.json --yes
# --unattended is an alias for --config
```

Examples:

| File | Scenario |
| --- | --- |
| `examples/unattended-standard.json` | DHCP, ZFS single, one system + one data disk, SSH key only. |
| `examples/unattended-zfs-raid.json` | Static IP, raidz1 over four disks, NVMe cache, users and shares. |
| `examples/unattended-parity-array.json` | Parity + data + cache disks, shares over SMB/NFS. |

Replace the example SSH keys; never commit a real password. Config files that
contain `auth.password` must be mode `0600` (the validator rejects group/world
readable files).

### USB / ISO

Copy a config to the installation media as `/wrexr/autospec.json` (or pass
`wrexr.config=`), then choose the *Unattended install (autospec.json)* menu entry. The boot
hook copies the config to a private temporary path and calls:

```bash
/opt/wrexr/installer/wrexr-installer.sh --config /tmp/wrexr-install-XXXXXX.json --yes
```

### PXE

Extract `/live/vmlinuz` and `/live/initrd.img` from the ISO, export the live
squashfs over HTTP/NFS, and append:

```
boot=live components fetch=http://pxe/wrexr/filesystem.squashfs wrexr.install=unattended wrexr.config=http://pxe/autospec.json
```

## Dry run

`--dry-run` validates the configuration, prints every command that would run
(including destructive `sgdisk` calls) and never touches a disk or writes a
file. It is safe to use for reviewing a config on a non-appliance machine:

```bash
bash installer/wrexr-installer.sh --config installer/examples/unattended-standard.json --dry-run --yes
```

## Configuration reference

The full schema is `installer/unattended.schema.json` (JSON Schema 2020-12).
Highlights:

| Key | Default | Notes |
| --- | --- | --- |
| `hostname` | `wrexr` | RFC-style hostname. |
| `timezone`, `keyboardLayout` | `UTC`, `us` | |
| `filesystem` | `zfs` | `zfs`, `btrfs`, `ext4`. |
| `raid` | `single` | `mirror`, `raidz1`, `raidz2`, `raidz10`. |
| `swap`, `swapSize` | `true`, `4G` | Swap partition on every system disk. |
| `disks[]` | required | `path` + `role` (`system`/`parity`/`data`/`cache`), `wipe` defaults to true. Paths must be unique; at least one `system` disk. `wipe:false` is rejected because the installer cannot preserve existing data. |
| `network` | required | `mode: dhcp\|static`; static requires `address`, `netmask`, `gateway`, `dns[]`. Optional `firewall.allowTcp`. |
| `auth` | required | `password` (min 12 chars) and/or `sshKeys[]`. |
| `users[]`, `shares[]` | `[]` | Local users and SMB/NFS/FTP shares. |
| `uiPort`, `updateChannel`, `repoUrl` | `8443`, `stable`, `https://repo.wrexr.io` | Written to `/etc/wrexr/wrexrd.toml`. |
| `force` | `false` | Must be true for unattended installs. |

Defaults are injected by `validate-config.mjs`; `--print-defaults` shows the
normalized document. Unknown keys are rejected.

## Safety notes

* Verify device names with `lsblk` and keep a backup. Wiped disks are not recoverable.
* Disks in use by the live system (including the ISO/USB device) are never offered or accepted.
* The installer refuses to run unattended without `force: true` **and** `--yes`.
* In interactive mode a typed `WIPE MY DISKS` confirmation is required unless
  `--yes` is supplied.
* No root password is hardcoded. Prefer SSH keys; if a password is used, store
  the config with mode `0600` and delete it after installation.
* On failure, the error trap prints explicit unmount/`zpool export`/`mdadm --stop`
  rollback hints. Nothing is rebooted automatically.
* After installation the first-boot wizard is required
  (`/var/lib/wrexr/setup-complete` is absent) and the management URL is
  `https://<ip>:<uiPort>/`.
