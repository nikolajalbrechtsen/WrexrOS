# Advanced installation reference

The advanced installer exposes every decision the standard path makes for you. It uses the
same JSON configuration and validator as unattended installs, so every option below has a
schema key in [`installer/unattended.schema.json`](../installer/unattended.schema.json).

## Invocation

```bash
# Guided advanced wizard
sudo /opt/wrexr/installer/wrexr-installer.sh --advanced

# Validate and preview an unattended configuration
node installer/validate-config.mjs install.json --print-defaults
sudo /opt/wrexr/installer/wrexr-installer.sh --config install.json --dry-run --yes

# Apply it (force:true in the config and --yes are both required)
sudo /opt/wrexr/installer/wrexr-installer.sh --config install.json --yes
```

`--dry-run` prints partition, filesystem, network and service commands without writing to a
disk. Always run it first on a new hardware layout.

## Option reference

### Identity and locale

`uiPort`, `updateChannel`, `repoUrl` and `demoMode` are written to
`/etc/wrexr/wrexrd.toml`, which `wrexrd` reads at startup via `WREXR_CONFIG`.

| Key | Default | Notes |
| --- | --- | --- |
| `hostname` | `wrexr` | RFC 1123 label. |
| `timezone` | `UTC` | IANA name such as `Europe/Copenhagen`. |
| `keyboardLayout` | `us` | Console keyboard layout. |
| `uiPort` | `8443` | HTTPS port for `wrexrd`. |
| `updateChannel` | `stable` | `stable` or `beta`. |
| `repoUrl` | `https://repo.wrexr.io` | Written to `/etc/wrexr/wrexrd.toml`. |
| `demoMode` | `false` | Not intended for production installs. |
| `kernelOptions` | `[]` | Extra GRUB cmdline entries, for example `intel_iommu=on`. |

### Disks and storage

| Key | Values | Notes |
| --- | --- | --- |
| `disks[].path` | `/dev/sdX`, `/dev/nvmeXnY`, `/dev/disk/by-id/...` | Must exist, be a whole disk, and not be in use by the live system. |
| `disks[].role` | `system`, `data`, `parity`, `cache` | At least one `system` disk is required. |
| `disks[].wipe` | `true` / `false` | The installer only accepts disks it may erase; `false` is rejected. |
| `disks[].model` | string | Optional human-readable label. |
| `filesystem` | `zfs`, `btrfs`, `ext4` | Root and storage pool filesystem. |
| `raid` | `single`, `mirror`, `raidz1`, `raidz2`, `raidz10` | Applies to root and storage members. |
| `swap` / `swapSize` | `true` / `4G` | Creates a swap partition on every system disk. |

Minimum member counts enforced by the installer:

| RAID level | Minimum devices |
| --- | --- |
| `single` | 1 |
| `mirror` | 2 |
| `raidz1` | 3 |
| `raidz2` | 4 |
| `raidz10` | 4 (even number) |

Role notes:

* `system` disks hold the root filesystem. Multiple system disks form a ZFS mirror, btrfs
  RAID1, or mdadm RAID1/5/6/10 according to `raid`.
* `data` and `parity` disks form the storage pool mounted at `/mnt/wrexr`. `parity` members
  require `raidz1` (exactly one parity disk) or `raidz2` (exactly two). btrfs does not support
  parity roles; use ZFS or ext4/mdadm.
* `cache` disks become ZFS L2ARC devices. With btrfs/ext4 they are reported as unused.
* Every selected disk is irreversibly wiped after confirmation.

### Network

| Key | Default | Notes |
| --- | --- | --- |
| `network.mode` | `dhcp` | `dhcp` or `static`. |
| `network.interface` | `auto` | Physical management NIC; `auto` detects the first one with a device link. |
| `network.bridge` | `br0` | Linux bridge created over the management NIC. |
| `network.address` | — | Static IPv4 address, required with `mode: static`. |
| `network.netmask` | — | Dotted decimal netmask, required with `mode: static`. |
| `network.gateway` | — | IPv4 gateway, required with `mode: static`. |
| `network.dns` | — | At least one resolver, required with `mode: static`. |
| `network.firewall.enabled` | `true` | Enable nftables defaults. |
| `network.firewall.allowTcp` | `[22, 8443]` | Inbound TCP ports. |

Networking is written with Debian `ifupdown` to `/etc/network/interfaces.d/wrexr`. No
netplan, VLAN tagging, proxy configuration or Wi-Fi setup is performed. Static DNS is also
written to `/etc/resolv.conf`.

### Credentials and users

| Key | Notes |
| --- | --- |
| `auth.password` | Root password, at least 12 characters; no `:` or newlines. |
| `auth.sshKeys` | Root `authorized_keys` entries. Either a password or a key is required. |
| `users[].name` | Local account name. |
| `users[].groups` | Supplementary groups. |
| `users[].shell` | Login shell, default `/bin/bash`. |
| `users[].password` | Optional account password; keys in `users[].sshKeys` also work. |
| `users[].sshKeys` | Per-user SSH keys. |
| `shares[]` | `name`, `protocol` (`smb`/`nfs`/`ftp`), `path`, `readOnly`, `recycle`, `users`. |

Config files containing any password must be mode `0600`. With keys only, password SSH
authentication is disabled; with a password and no keys, direct root password login is
enabled so the installed system is reachable.

## Partitioning and boot details

Each system disk receives:

```text
/dev/sdX1  512 MiB  EFI System Partition (FAT32, mounted /boot/efi)
/dev/sdX2  1 MiB    BIOS Boot Partition
/dev/sdX3  [swap]   Linux swap, when swap=true
/dev/sdX3/4 rest    WrexrOS root
```

GRUB is installed for legacy BIOS on every system disk and for UEFI on every EFI partition
when the live system booted in UEFI mode. Kernel command lines include `root=ZFS=rpool` for
ZFS or `rootflags=subvol=@` for Btrfs.

* ZFS root pool `rpool` uses `compression=lz4`, `atime=off`, `xattr=sa`, `bootfs=rpool` and a
  cachefile copied into the target. Storage pool `tank` uses `compression=zstd`.
* Btrfs root uses subvolumes `@` and `@home`; `/mnt/wrexr` is a separate data filesystem.
* ext4/mdadm arrays are registered in `/etc/mdadm/mdadm.conf`.

## Recovery

If an install fails, the error trap unmounts target filesystems, exports ZFS pools and stops
mdadm arrays, then prints manual rollback hints. The live ISO includes a **Rescue shell**
option; import a pool with `zpool import -f -R /mnt rpool` (or mount the Btrfs root), chroot
and inspect `/etc/wrexr/install-state.json`. Partially wiped disks cannot be recovered
automatically — keep physical backups.
