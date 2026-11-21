# WrexrOS boot integration

These files provide the console banner, first-boot preparation and systemd glue for
the installed appliance. The ISO copies this directory to `/opt/wrexr/boot/`.

## Files

| File | Purpose |
| --- | --- |
| `wrexr-console.sh` | Detects the management IP, reads the UI port from `/etc/wrexr/wrexrd.toml`, renders the banner and writes `/etc/issue.d/10-wrexr.issue`. |
| `wrexr-banner.service` | Oneshot unit that runs the console script before `getty@tty1`. |
| `issue` | Static fallback issue file (with ANSI escape sequences) if the script cannot write at boot. |
| `firstboot.sh` | Ensures `/var/lib/wrexr/setup-complete` is absent on fresh installs, generates a self-signed TLS certificate if needed and prints the management URL. |

## Usage

```bash
# Regenerate the login banner (writes /etc/issue.d/10-wrexr.issue when permitted)
sudo /opt/wrexr/boot/wrexr-console.sh --once

# Only print the banner; no file is changed
/opt/wrexr/boot/wrexr-console.sh --print

# First-boot preparation (idempotent)
sudo /opt/wrexr/boot/firstboot.sh
```

The UI port defaults to `8443` when `wrexrd.toml` is missing or unreadable.
The IP lookup prefers `br0`, `vmbr0`, `lan0`, `eth0` and common enumerations, then
falls back to the first address from `hostname -I`.

## Kiosk mode

Set `WREXR_KIOSK=1` in the environment (or use `wrexr-kiosk.service`) to open the
read-only dashboard URL `https://<ip>:<port>/dashboard?readonly=1` in Chromium.
The script exits with a warning when Chromium or `DISPLAY` is unavailable; it never
fails the boot because of kiosk mode.

## First-boot marker

The daemon treats a missing `/var/lib/wrexr/setup-complete` as "setup required".
The installer removes the marker and `firstboot.sh` only removes it again when
`WREXR_FORCE_SETUP=1` is set, so a completed setup is not reset by later reboots.
