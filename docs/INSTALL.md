# Installing WrexrOS

This guide covers the supported installation paths for 0.1.3. All installations are
**destructive on the target disk**; the installer prints every destructive command in
`--dry-run` mode first.

## Requirements

| Item | Minimum | Recommended |
| --- | --- | --- |
| CPU | x86-64 with VT-x/AMD-V for VMs | 4 cores |
| RAM | 4 GB | 16 GB+ |
| System disk | 32 GB | 128 GB SSD/NVMe (mirror for redundancy) |
| Network | 1 Ethernet NIC | 2+ NICs for separate LAN/VM bridges |
| Boot | UEFI or legacy BIOS | UEFI/BIOS boot records are both written; disable Secure Boot during install |

Optional: extra disks for the parity array, an IOMMU-capable CPU/board for GPU passthrough.

## 1. Get and verify the image

```bash
VERSION=0.1.3
curl -LO "https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v${VERSION}/WrexrOS-${VERSION}-amd64.iso"
curl -LO "https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v${VERSION}/SHA256SUMS"
grep "WrexrOS-${VERSION}-amd64.iso" SHA256SUMS | sha256sum -c -
```

If a detached signature is published and `/etc/wrexr/trusted-updates.gpg` is installed, also
verify it:

```bash
gpg --verify "WrexrOS-${VERSION}-amd64.iso.asc" "WrexrOS-${VERSION}-amd64.iso"
```

## 2. Write to USB

Linux:

```bash
sudo dd if="WrexrOS-${VERSION}-amd64.iso" of=/dev/sdX bs=4M status=progress conv=fsync
```

Windows: use [Rufus](https://rufus.ie/) in DD image mode or
[Etcher](https://www.balena.io/etcher/).

The image is hybrid and boots from USB in both UEFI and legacy BIOS mode. Ventoy users should
select the ISO in Ventoy's menu; if the VM firmware cannot boot the passthrough USB device,
copy the ISO directly to the hypervisor storage and attach it as a CD/DVD instead.

## 3. Boot menu

The ISO shows:

* **Standard install** — guided disk selection and sensible defaults.
* **Advanced install** — manual disk partitioning, filesystem/RAID, parity roles, network,
  locale, credentials, users, shares and kernel options.
* **Unattended install** — reads `/run/live/medium/wrexr/autospec.json` (or the
  `wrexr.config=...` kernel argument). An example is shipped at
  `/wrexr/autospec.example.json` on the media.
* **Rescue shell** — live root shell for recovery.
* **Live shell (no installer autostart)** — skip installation and open a root shell.
* **Try WrexrOS without installing** — live root shell. The management UI starts after installation,
  not in the live session.

Every entry states its install mode explicitly; rescue and live entries disable the installer
autostart hook. The live image starts only the installer, so it does not run `wrexrd`, the
updater timer or Docker's storage-driver probe.

## 4. Standard install

1. Choose **Standard install** and accept the disk summary. The smallest unused disk ≥ 32 GB
   becomes the system disk. Two or more remaining disks default to a ZFS mirror; one remaining
   disk becomes a single-disk pool.
2. Confirm network: DHCP on `br0` by default, hostname `wrexr`, timezone UTC, keyboard `us`.
   The management interface is auto-detected on Proxmox virtio, Intel and Realtek NICs.
3. Set a root password **or** paste an SSH public key. There is no default password.
4. Confirm the destructive warning, then wait for `debootstrap`, kernel, Node 24 and GRUB
   installation.
5. Reboot and remove the installation media.

## 5. Advanced install

See [ADVANCED_INSTALL.md](ADVANCED_INSTALL.md) for the full option reference. In short, the
advanced wizard asks for:

* disk selection and role per disk (`system`, `parity`, `data`, `cache`),
* filesystem (`zfs`, `btrfs`, `ext4`) and RAID level (`single`, `mirror`, `raidz1`,
  `raidz2`, `raidz10`),
* static IPv4 (address/netmask/gateway/DNS) or DHCP, bridge name and firewall ports,
* hostname, timezone and keyboard layout,
* root password or SSH keys, optional local users and shares,
* kernel command-line options (IOMMU for GPU passthrough, etc.).

Preview without touching disks:

```bash
sudo /opt/wrexr/installer/wrexr-installer.sh --advanced --dry-run --yes
```

## 6. Unattended install

Write a config file (examples in `installer/examples/`):

```json
{
  "version": 1,
  "hostname": "wrexr-node1",
  "timezone": "Europe/Copenhagen",
  "keyboardLayout": "dk",
  "filesystem": "zfs",
  "raid": "raidz1",
  "swap": true,
  "swapSize": "4G",
  "uiPort": 8443,
  "updateChannel": "stable",
  "kernelOptions": ["intel_iommu=on"],
  "force": true,
  "disks": [
    { "path": "/dev/sda", "role": "system" },
    { "path": "/dev/sdb", "role": "parity" },
    { "path": "/dev/sdc", "role": "data" },
    { "path": "/dev/sdd", "role": "data" }
  ],
  "network": {
    "mode": "static",
    "interface": "auto",
    "bridge": "vmbr0",
    "address": "192.168.1.24",
    "netmask": "255.255.255.0",
    "gateway": "192.168.1.1",
    "dns": ["1.1.1.1", "9.9.9.9"]
  },
  "auth": {
    "sshKeys": ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIReplaceWithYourKey admin@laptop"]
  }
}
```

Validate and install:

```bash
chmod 600 install.json
node installer/validate-config.mjs install.json
sudo /opt/wrexr/installer/wrexr-installer.sh --config install.json --yes
```

For ISO/USB boots, place the file on the installation media as
`/wrexr/autospec.json`; the boot hook copies it to a private temporary path and starts the
installer. For PXE, append
`wrexr.install=unattended wrexr.config=http://server/install.json` to the kernel command line.
The live systemd boot hook, not the initramfs, fetches the JSON and starts the installer after
network-online is reached.

## 7. First boot

The console displays:

```text
WrexrOS 0.1.3
https://192.168.1.24:8443

wrexros login:
```

Open `https://<IP>:8443`. Your browser will warn about the self-signed certificate — accept
it once, then replace it under **Settings → Updates/Advanced** or enable Let's Encrypt via a
reverse proxy. The first-run wizard sets the root password (if not provided by SSH key),
confirms network and storage, and optionally creates a share and a VM.

## 8. Post-install checks

```bash
systemctl status wrexrd wrexr-console wrexr-updater.timer
wrexctl status
zpool status
docker info
sudo smartctl -a /dev/sdb
```

## Proxmox VE

Copy the ISO to the Proxmox host directly rather than relying on USB passthrough:

```bash
cd /var/lib/vz/template/iso
VERSION=0.1.3
wget -O "WrexrOS-${VERSION}-amd64.iso" \
  "https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v${VERSION}/WrexrOS-${VERSION}-amd64.iso"
wget -O SHA256SUMS \
  "https://github.com/nikolajalbrechtsen/WrexrOS/releases/download/v${VERSION}/SHA256SUMS"
grep "WrexrOS-${VERSION}-amd64.iso" SHA256SUMS | sha256sum -c -

qm stop 200
qm set 200 --ide2 "local:iso/WrexrOS-${VERSION}-amd64.iso,media=cdrom"
qm set 200 --boot 'order=ide2;scsi0'
qm start 200
```

After the install completes and before rebooting into the disk:

```bash
qm set 200 --boot 'order=scsi0'
qm set 200 --ide2 none,media=cdrom
```

Use `ide2` for the ISO and the `;` separator in `--boot order=...`; Proxmox does not accept
`cd` or `hd` as boot device names.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| No IP in banner | Check cable/link, then `ip a`; set static IP in the wizard |
| Browser certificate warning | Expected on first boot; install your own cert |
| `wrexrd` fails in the live installer | Expected in 0.1.2; resolved in 0.1.3, where the live image starts only the installer |
| `wrexrd` fails after installation | `journalctl -u wrexrd -xe`; check `/etc/wrexr/wrexrd.toml` |
| ZFS pool missing after reboot | `zpool import`; verify disk role assignment |
| Installer refuses a disk | Disk is mounted, too small, or marked `wipe:false`; inspect `lsblk -f` |
| Ventoy reports “not bootable” | Copy the ISO to Proxmox/local storage and attach it as `ide2` CD/DVD |
