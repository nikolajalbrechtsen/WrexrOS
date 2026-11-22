# Live updates

WrexrOS treats updates as a first-class feature: the same checker powers the Settings →
Updates screen, `wrexctl update check`, and the daily systemd timer.

## Source of truth

All release information comes from the canonical repository:

```text
https://github.com/nikolajalbrechtsen/WrexrOS.git
API: https://api.github.com/repos/nikolajalbrechtsen/WrexrOS/releases/latest
```

`VERSION` in the repository root is the current version. Releases are tagged `vX.Y.Z` by
CI. Beta releases are tagged `vX.Y.Z-beta.N` and are selected by the `beta` channel.

Each release publishes:

* `WrexrOS-<version>-amd64.iso` — full installation media.
* `WrexrOS-<version>-linux-amd64.tar.gz` — code bundle used by the in-place updater.
* `SHA256SUMS` — checksums for both assets.
* `SHA256SUMS.asc` — optional detached signature when a release key is configured.

## Checking

```bash
node updater/check-update.mjs --channel stable --json
wrexctl update check --json
curl -k -H "Authorization: Bearer $TOKEN" .../api/v1/updates/check
```

Example JSON:

```json
{
  "current": "0.1.4",
  "latest": "0.2.0",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.2.0",
  "publishedAt": "2026-11-22T12:00:00Z",
  "assets": [
    {
      "name": "WrexrOS-0.2.0-amd64.iso",
      "size": 1185366016,
      "downloadUrl": "https://github.com/.../WrexrOS-0.2.0-amd64.iso",
      "contentType": "application/octet-stream"
    }
  ]
}
```

Offline or GitHub rate-limit failures return exit code 2 and a structured error; the daemon
keeps the last known result so the UI never shows a misleading "up to date" state.

## Verification and install

```bash
sudo ./updater/wrexr-update.sh --check
sudo ./updater/wrexr-update.sh --install              # confirms, verifies, swaps, restarts
sudo ./updater/wrexr-update.sh --install 0.1.4 --yes  # specific version, non-interactive
sudo ./updater/wrexr-update.sh --verify-only ./asset.tar.gz ./SHA256SUMS.asc
```

Steps:

1. Fetch release metadata and select the Linux/amd64 `.tar.gz` bundle. Override the selection
   with `WREXR_ASSET_PATTERN` if you publish a custom bundle.
2. Download the bundle, `SHA256SUMS` and `SHA256SUMS.asc` into a temporary directory.
3. Verify the SHA-256 checksum with `updater/verify-release.mjs`.
4. If `/etc/wrexr/trusted-updates.gpg` exists, require and verify the detached `.asc`
   signature. **With a trust key installed, unsigned updates are refused.**
5. Extract the bundle into `/opt/wrexr.new.<pid>`, move the current tree to
   `/opt/wrexr-backups/wrexr-<timestamp>` and atomically swap it into `/opt/wrexr`.
6. Restart `wrexrd` and append a JSON audit event to `/var/log/wrexr/audit.log`.

If the service restart fails after the swap, the previous tree is moved back automatically.
Manual rollback:

```bash
sudo systemctl stop wrexrd
sudo mv /opt/wrexr /opt/wrexr.failed
sudo mv /opt/wrexr-backups/<timestamp> /opt/wrexr
sudo systemctl start wrexrd
```

Full ISO upgrades are a fresh install (back up `/etc/wrexr` and `/var/lib/wrexr` first).
In-place updates replace code, not the Debian base; base OS upgrades are delivered as a new
ISO.

## Automatic security patches

`wrexrd` can optionally run `apt-get update && unattended-upgrade` for Debian security
sources only. Configure under **Settings → Updates → Automatic security updates**. This is
off by default so administrators can schedule a maintenance window.

## Signing model

Maintainers may configure `RELEASE_GPG_PRIVATE_KEY` and `RELEASE_GPG_PASSPHRASE` in GitHub
Actions. When present, CI signs the ISO, code bundle and `SHA256SUMS`; export the public key
to `/etc/wrexr/trusted-updates.gpg` on installed systems. Without a configured key, releases
are published unsigned and checksum verification still applies.

App templates in the catalog use the same trust model: `trusted: true` templates carry a
verifiable signature; community templates show a warning until explicitly trusted by the
administrator.

## Timer

`systemd/wrexr-updater.timer` runs `wrexr-update.service` daily with a random delay. It only
checks by default; installation requires an explicit action in the UI or CLI. The UI shows a
badge when an update is available.
