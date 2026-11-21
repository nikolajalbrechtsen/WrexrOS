# Installing WrexrOS

This guide covers the supported installation paths for 0.1.0. All installations are
**destructive on the target disk**; the installer prints every destructive command in
`--dry-run` mode first.

## Requirements

| Item | Minimum | Recommended |
| --- | --- | --- |
| CPU | x86-64 with VT-x/AMD-V for VMs | 4 cores |
| RAM | 4 GB | 16 GB+ |
| System disk | 32 GB | 128 GB SSD/NVMe (mirror for redundancy) |
| Network | 1 Ethernet NIC | 2+ NICs for separate LAN/VM bridges |
| Boot | UEFI (BIOS+MBR also supported) | UEFI with Secure Boot disabled during install |

Optional: extra disks for the parity array, an IOMMU-capable CPU/board for GPU passthrough.

## 1. Get and verify the image

```bash
curl -LO https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v0.1.0/WrexrOS-0.1.0-amd64.iso
curl -LO https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v0.1.0/SHA256SUMS
sha256sum -c SHA256SUMS
```

If `/etc/wrexr/trusted-updates.gpg` is installed, also verify the detached signature:

```bash
gpg --verify WrexrOS-0.1.0-amd64.iso.asc WrexrOS-0.1.0-amd64.iso
```

## 2. Write to USB

Linux:

```bash
sudo dd if=WrexrOS-0.1.0-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync
```

Windows: use [Rufus](https://rufus.ie/) in DD image mode or
[Etcher](https://www.balena.io/etcher/).

## 3. Boot menu

The ISO shows:

* **Standard install** — guided disk selection and sensible defaults.
* **Advanced install** — manual disk partitioning, filesystem/RAID, parity roles, network,
  locale, credentials, kernel options.
* **Unattended install** — reads `/mnt/usb/install.json` (or `wrexr.config=...` kernel arg).
* **Rescue shell** — live root shell for recovery.
* **Boot existing system** — skip installation.

## 4. Standard install

1. Choose **Standard install** and accept the disk summary. The smallest disk ≥ 32 GB becomes
   the system disk (ZFS single disk, or a mirror if exactly two equal-size disks are found).
   Remaining disks are added as data disks.
2. Confirm network: DHCP by default, hostname `wrexr-<random>`, timezone UTC.
3. Set a root password **or** paste an SSH public key. There is no default password.
4. Confirm the destructive warning, then wait for `debootstrap` and bootloader installation.
5. `systemctl reboot` and remove the installation media.

## 5. Advanced install

See [ADVANCED_INSTALL.md](ADVANCED_INSTALL.md) for the full option reference. In short, the
advanced wizard asks for:

* disk selection and role per disk (`system`, `parity`, `data`, `cache`),
* filesystem (`zfs`, `btrfs`, `ext4`) and RAID level (`single`, `mirror`, `raidz1`,
  `raidz2`, `raidz10`),
* static IP / netmask / gateway / DNS or DHCP, bridge name and VLAN tag,
* hostname, timezone, keyboard layout, language,
* root password or SSH keys, optional lock-root-login,
* kernel command-line options (IOMMU for GPU passthrough, etc.),
* optional first share and first VM to create after setup.

Preview without touching disks:

```bash
sudo wrexr-installer --interactive --dry-run
```

## 6. Unattended install

Write a config file (examples in `installer/examples/`):

```json
{
  "version": 1,
  "mode": "standard",
  "hostname": "wrexr-node1",
  "timezone": "Europe/Copenhagen",
  "keyboard": "dk",
  "locale": "en_US.UTF-8",
  "system": {
    "disk": "/dev/sda",
    "filesystem": "zfs",
    "raid": "single",
    "kernelOptions": ["intel_iommu=on"]
  },
  "network": {
    "mode": "static",
    "interface": "eno1",
    "address": "192.168.1.24/24",
    "gateway": "192.168.1.1",
    "dns": ["1.1.1.1", "9.9.9.9"]
  },
  "credentials": { "sshKeys": ["ssh-ed25519 AAAA... admin@laptop"] },
  "array": {
    "parity": ["/dev/sdb"],
    "data": ["/dev/sdc", "/dev/sdd"]
  }
}
```

Validate and install:

```bash
node installer/validate-config.mjs install.json
sudo wrexr-installer --config install.json --yes
```

For PXE, append `wrexr.install=unattended wrexr.config=http://server/install.json` to the
kernel command line. The ISO initramfs fetches the JSON, validates it, and starts the
installer.

## 7. First boot

The console displays:

```text
WrexrOS 0.1.0
https://192.168.1.24:8443

wrexros login:
```

Open `https://<IP>:8443`. Your browser will warn about the self-signed certificate — accept
it once, then replace it under **Settings → Updates/Advanced** or enable Let's Encrypt via
the reverse proxy. The first-run wizard sets the root password (if not provided by SSH key),
confirms network and storage, and optionally creates a share and a VM.

## 8. Post-install checks

```bash
systemctl status wrexrd wrexr-console wrexr-updater.timer
wrexctl status
zpool status
docker info
sudo smartctl -a /dev/sdb
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No IP in banner | Check cable/link, then `ip a`; set static IP in the wizard |
| Browser certificate warning | Expected on first boot; install your own cert |
| `wrexld` fails to start | `journalctl -u wrexrd -xe`; check `/etc/wrexr/wrexrd.toml` |
| ZFS pool missing after reboot | `zpool import`; verify disk role assignment |
| Installer refuses a disk | Disk is mounted or too small; inspect `lsblk -f` |
