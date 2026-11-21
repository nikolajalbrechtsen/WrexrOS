# Third-party components

WrexrOS integrates — and does not replace — the following upstream projects. Their licenses
and trademarks remain with their respective owners.

| Component | License | Used for |
| --- | --- | --- |
| Debian GNU/Linux | DFSG / various | Base userland and kernel |
| Linux kernel | GPL-2.0 | Host kernel, KVM, ZFS module |
| QEMU | GPL-2.0 / LGPL | Machine emulation |
| KVM | GPL-2.0 | Hardware virtualisation |
| libvirt | LGPL-2.1 | VM lifecycle API (`virsh`) |
| LXC | LGPL-2.1+ | System containers |
| Docker Engine / CLI | Apache-2.0 | App containers |
| Samba | GPL-3.0 | SMB/CIFS shares |
| NFS utilities | GPL-2.0 | NFS exports |
| vsftpd | GPL-2.0 | FTP/FTPS |
| OpenSSH | BSD-style | Remote CLI access |
| OpenZFS | CDDL | ZFS pools/datasets/snapshots |
| Btrfs | GPL-2.0 | Copy-on-write filesystem |
| mdadm | GPL-2.0 | Software RAID fallback |
| smartmontools | GPL-2.0+ | SMART disk health |
| netplan | GPL-3.0 | Declarative network config |
| nftables | GPL-2.0 | Firewall |
| Node.js | MIT | `wrexrd`, `wrexctl`, updater |
| systemd | LGPL-2.1+ | Service management |

No third-party JavaScript is bundled in the web UI: the SPA, renderer, charts and CLI are
original code in this repository using only platform built-ins.
