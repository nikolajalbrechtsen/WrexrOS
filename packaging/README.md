# Building the WrexrOS ISO

The image is a Debian `bookworm` amd64 live/hybrid ISO built with `live-build`.
It contains the Debian installer, the WrexrOS runtime under `/opt/wrexr`, the
systemd units, the console scripts and any locally built `.deb` files placed in
`packaging/packages/`.

## Build with Docker (recommended)

```bash
docker build -t wrexros-builder -f packaging/Dockerfile .
mkdir -p out
docker run --rm --privileged -v "$PWD/out:/build/out" wrexros-builder
```

The container runs `packaging/build-iso.sh --allow-root --output /build/out`.
`--privileged` is needed because live-build mounts and chroots into the image
tree. The builder image sets `WREXR_ALLOW_ROOT=1`, so no extra flag is required.

## Build on a Debian host

```bash
sudo apt install live-build dosfstools xorriso squashfs-tools rsync qemu-utils \
                 grub-efi-amd64-bin curl ca-certificates nodejs
sudo WREXR_ALLOW_ROOT=1 ./packaging/build-iso.sh --output ./out
```

The script refuses to run as root unless `--allow-root` is given or
`WREXR_ALLOW_ROOT=1` is set. Other options:

```bash
./packaging/build-iso.sh --version          # print version from ../VERSION
./packaging/build-iso.sh --clean            # remove packaging/build only
./packaging/build-iso.sh --output /srv/iso --allow-root
```

The version is read from the repository root `VERSION` file (fallback: `0.1.2`,
override with `WREXR_VERSION`). Results:

```
out/WrexrOS-<version>-amd64.iso
out/SHA256SUMS
```

Verify with `sha256sum -c SHA256SUMS`.

## Hardware requirements

* 64-bit x86 (amd64) CPU with VT-x/AMD-V for VMs; 2+ cores recommended.
* 4 GiB RAM minimum (2 GiB for a storage-only install), 8+ GiB recommended.
* System disk: 32 GiB minimum, 64+ GiB recommended. EFI and BIOS boot are both
  supported (512 MiB EFI partition, 1 MiB BIOS boot partition, optional swap).
* Additional disks for ZFS/Btrfs storage; ECC RAM and a separate SSD/NVMe cache
  device are recommended for ZFS parity pools.
* One management NIC with DHCP or a static IPv4 address.

## Boot menu and installation

The ISOLINUX and GRUB menus offer Standard install, Advanced install, Unattended install
(expects `/run/live/medium/wrexr/autospec.json`), Rescue shell, Boot existing system and
Try without installing. Every menu choice passes `wrexr.install=` explicitly; an empty value
disables autostart. Unattended entries also pass `wrexr.config=`. The
`wrexr-live-install.service` unit consumes those parameters, fetches HTTP(S) config URLs and
starts the matching installer path automatically. After booting, you can also run manually:

```bash
sudo /opt/wrexr/installer/wrexr-installer.sh --interactive
sudo /opt/wrexr/installer/wrexr-installer.sh --config installer/examples/unattended-standard.json --yes
sudo /opt/wrexr/installer/wrexr-installer.sh --config /run/live/medium/wrexr/autospec.json --dry-run --yes
```

The management UI is on `https://<management-ip>:8443/` by default.

## Flashing to USB

```bash
# Replace /dev/sdX with the USB stick - this destroys all data on it!
sudo dd if=out/WrexrOS-<version>-amd64.iso of=/dev/sdX bs=4M status=progress conv=fsync
```

Alternatively use balenaEtcher or Rufus (DD mode). The image is hybrid: it boots
from USB in both UEFI and legacy BIOS mode.

## PXE notes

1. Copy `vmlinuz` and `initrd.img` from `/live/` inside the ISO to your TFTP root.
2. Export the ISO contents over NFS/HTTP as the live filesystem source.
3. Example PXE append line:

```
APPEND initrd=wrexr/initrd.img boot=live components quiet splash fetch=http://pxe/wrexr/filesystem.squashfs wrexr.install=unattended wrexr.config=http://pxe/autospec.json
```

4. For a fully unattended PXE boot, place a 0600 JSON config at the configured
   `wrexr.config` path and ensure the boot hook invokes
   `wrexr-installer.sh --config <file> --yes`.
5. DHCP reservations are recommended so the first-boot banner shows a stable IP.

## Caveats

* Debian bookworm ships Node 18, so the builder embeds a checksum-verified Node 24 runtime in
  `/opt/wrexr-node` and `/opt/wrexr/runtime`. The installer copies it into the installed
  system and `/usr/local/bin/node` points at it. Bare-metal builds need `curl` and `xz-utils`
  to fetch and unpack that runtime.
* Secure Boot should be disabled during installation and first boot unless you enrol the
  signing keys for your firmware. The installed system uses standard Debian GRUB packages.
* Locally built `.deb` files are copied to `/wrexr/packages` on the ISO (reachable as
  `/run/live/medium/wrexr/packages`) and installed by the installer when present.
