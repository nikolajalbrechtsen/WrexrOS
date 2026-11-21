# Advanced installation reference

The advanced installer exposes every decision the standard path makes for you. It is the
same engine used by unattended installs, so every option below has a JSON key.

## Invocation

```bash
sudo wrexr-installer --interactive --advanced
sudo wrexr-installer --config install.json --dry-run
sudo wrexr-installer --config install.json --yes
```

`--dry-run` prints partition commands, zpool/btrfs creation, network files and service
enablement but performs no writes. Always run it first on a new hardware layout.

## Option reference

### Disks and storage

| Prompt | JSON key | Values | Notes |
| --- | --- | --- | --- |
| System disk | `system.disk` | `/dev/...` | Must be ≥ 32 GB; wiped by install |
| Additional system disks | `system.mirrors` | array | Creates a ZFS mirror or btrfs RAID1 |
| Filesystem | `system.filesystem` | `zfs`, `btrfs`, `ext4` | ZFS recommended |
| RAID level | `system.raid` | `single`, `mirror`, `raidz1`, `raidz2`, `raidz10` | `mirror`/`raidz*` need matching disks |
| EFI size | `system.efiSize` | MiB, default 512 | Enough for multiple kernels |
| Swap | `system.swapSize` | MiB, 0 disables | ZFS users may prefer a swapfile |
| Data disks | `array.data` | array | Unraid-style array members |
| Parity disks | `array.parity` | array | 1 or 2 parity disks |
| Cache/SLOG | `array.cache` | array | Optional SSD |
| Encryption | `system.encryption` | `none`, `luks` | Key file stored in `/etc/wrexr` |
| Kernel options | `system.kernelOptions` | array | e.g. `intel_iommu=on`, `amd_iommu=on` |

Disk roles are exclusive: a disk cannot be both parity and data. The validator rejects
duplicates and disks smaller than the system disk when used as parity.

### Network

| Prompt | JSON key | Notes |
| --- | --- | --- |
| Mode | `network.mode` | `dhcp` or `static` |
| Interface | `network.interface` | Physical NIC for management |
| Address | `network.address` | CIDR, e.g. `192.168.1.24/24` |
| Gateway | `network.gateway` | IPv4 address |
| DNS | `network.dns` | List of resolvers |
| Bridge | `network.bridge` | Name, default `vmbr0` |
| VLAN tag | `network.vlanTag` | Management VLAN, `null` for untagged |
| VLAN-aware | `network.vlanAware` | Enables trunking on VM bridge |
| Proxy | `network.proxy` | Optional HTTP proxy URL for updates |

Generated files: `/etc/network/interfaces.d/wrexr` (Debian) and, if netplan is detected,
`/etc/netplan/99-wrexr.yaml`. Both are shown in dry-run output.

### Identity and locale

| Prompt | JSON key | Notes |
| --- | --- | --- |
| Hostname | `hostname` | RFC 1123 label |
| Timezone | `timezone` | IANA name, e.g. `Europe/Copenhagen` |
| Keyboard | `keyboard` | `us`, `dk`, `de`, ... |
| Locale | `locale` | `en_US.UTF-8`, ... |
| Root password | `credentials.password` | Never written to the config in plaintext by the UI |
| SSH keys | `credentials.sshKeys` | List of `ssh-ed25519`/`ssh-rsa` keys |
| Disable root password login | `credentials.lockPassword` | SSH keys only |
| Users | `users[]` | `{name,passwordHash,sshKeys,roles}` |

No default password exists. If neither password nor SSH key is supplied, the installer
refuses to continue unless `--dry-run` is set.

### Update channel

`updates.channel` is `stable` (default) or `beta`. It is written into
`/etc/wrexr/wrexrd.toml` and controls which GitHub release the updater targets.

## Bootloader and partitioning details

For UEFI systems the installer creates:

```text
/dev/sdX1  512 MiB  EFI System Partition (FAT32, mounted /boot/efi)
/dev/sdX2  1 MiB    BIOS boot partition (if BIOS compatibility requested)
/dev/sdX3  rest     ZFS/Btrfs/ext4 root
```

ZFS gets `ashift=12`, `compression=lz4`, `atime=off`, `xattr=sa` and the dataset layout
`rpool/ROOT/wrexr`, `rpool/data`, `rpool/var-log`. Btrfs uses subvolumes `@`, `@home`,
`@var-log`. GRUB is installed to both EFI and BIOS paths when possible.

## Post-install hooks

`system.postInstall` can contain shell-free commands (argument arrays) executed in the
chroot after package installation, for example:

```json
"postInstall": [
  ["systemctl", "enable", "wrexr-updater.timer"],
  ["wrexctl", "update", "check"]
]
```

The installer refuses strings here to avoid shell injection.

## Recovery

If an install fails, the installer prints the last command and a rollback hint. The live
ISO includes a **Rescue shell** option: import the pool with `zpool import -f -R /mnt rpool`
(or mount the Btrfs root), chroot, and inspect `/etc/wrexr/install-state.json`. No automatic
rollback is attempted on a partially wiped disk — physical backup remains the only guarantee.
