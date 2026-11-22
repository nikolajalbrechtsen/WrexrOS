# WrexrOS systemd integration

Install these units on the target system (the ISO image and the installer do this
automatically):

```bash
sudo install -m 0644 systemd/wrexrd.service /etc/systemd/system/
sudo install -m 0644 systemd/wrexr-console.service /etc/systemd/system/
sudo install -m 0644 systemd/wrexr-updater.service systemd/wrexr-updater.timer /etc/systemd/system/
sudo install -m 0644 systemd/wrexr-kiosk.service /etc/systemd/system/
sudo install -m 0440 systemd/00-wrexr.conf /etc/sudoers.d/00-wrexr.conf
sudo visudo -cf /etc/sudoers.d/00-wrexr.conf
sudo systemctl daemon-reload
sudo systemctl enable --now wrexrd wrexr-console wrexr-updater.timer
```

## Units

| Unit | Purpose |
| --- | --- |
| `wrexrd.service` | Runs `/opt/wrexr/core/src/index.ts` with Node 24 (`--experimental-strip-types`) as the unprivileged `wrexr` user. |
| `wrexr-console.service` | Writes the login banner before `getty@tty1`. |
| `wrexr-updater.service` / `.timer` | Calls `/opt/wrexr/updater/wrexr-update.sh --check` daily, with persistence across downtime. |
| `wrexr-kiosk.service` | Optional read-only dashboard kiosk; enable only on machines with a graphical session. |

## Hardening notes

* `ProtectSystem=strict` makes the whole filesystem read-only except
  `/var/lib/wrexr`, `/etc/wrexr` and `/run/wrexr`. The TLS private key under
  `/var/lib/wrexr/tls` is readable by the daemon but settings changes are explicit.
* `CapabilityBoundingSet=` is empty and all privileged work is delegated through
  `00-wrexr.conf` (`NOPASSWD` + `NOEXEC`, explicit command allow-lists).
* `MemoryDenyWriteExecute=false` is a deliberate deviation: Node's JIT needs
  writable/executable anonymous memory.
* `AF_NETLINK` is allowed for interface discovery. If future code needs raw
  sockets or user namespaces, extend `RestrictAddressFamilies` /
  `RestrictNamespaces` here with a comment rather than disabling the options.
* The service is in `kvm`, `libvirt` and `docker` groups to reach local sockets;
  it still has no direct device nodes, so VM/container actions are audited by sudo.

## Verification

```bash
systemctl status wrexrd wrexr-console wrexr-updater.timer
systemctl list-timers wrexr-updater.timer
systemd-analyze security wrexrd.service
sudo -u wrexr sudo -n /usr/bin/virsh list --all
```
