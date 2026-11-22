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
CI. Beta releases are tagged `vX.Y.Z-beta.N` and only visible in the `beta` channel.

## Checking

```bash
node updater/check-update.mjs --channel stable --json
wrexctl update check --json
curl -k -H "Authorization: Bearer $TOKEN" .../api/v1/updates/check
```

Output:

```json
{
  "current": "0.1.1",
  "latest": "0.1.1",
  "updateAvailable": true,
  "releaseUrl": "https://github.com/nikolajalbrechtsen/WrexrOS/releases/tag/v0.1.1",
  "publishedAt": "2026-11-21T12:00:00Z",
  "assets": ["WrexrOS-0.1.1-amd64.iso", "SHA256SUMS"]
}
```

Offline or GitHub rate-limit failures return exit code 2 and a structured error; the daemon
keeps the last known result so the UI never shows a misleading "up to date" state.

## Verification and install

```bash
sudo wrexr-update.sh --check
sudo wrexr-update.sh --install          # confirms, verifies, swaps, restarts
sudo wrexr-update.sh --install 0.1.1 --yes
```

Steps:

1. Fetch release assets and `SHA256SUMS`.
2. Verify every downloaded asset with SHA-256 (`updater/verify-release.mjs`).
3. If `/etc/wrexr/trusted-updates.gpg` exists, verify the detached `.asc` signature with
   `gpg --verify`. **When a trust key is installed, unsigned updates are refused.**
4. Stage the payload in `/var/lib/wrexr/updates/staging/<version>`.
5. Atomically swap `/opt/wrexr` with the staged tree, keeping the previous tree as
   `/opt/wrexr.old`.
6. Restart `wrexrd` and emit an audit entry/event. Roll back with
   `sudo wrexr-update.sh --rollback` if health checks fail.

Full ISO upgrades are a fresh install (backup `/etc/wrexr` and `/var/lib/wrexr` first).
In-place updates replace code, not the Debian base; base OS upgrades are delivered as a new
ISO.

## Automatic security patches

`wrexrd` can optionally run `apt-get update && unattended-upgrade` for Debian security
sources only. Configure under **Settings → Updates → Automatic security updates**. This is
off by default so administrators can schedule a maintenance window.

## Signing model

Maintainers generate an Ed25519 signing key and export the public key into
`/etc/wrexr/trusted-updates.gpg` on installed systems (shipped via the ISO). CI signs each
release asset with the private key stored in GitHub Actions secrets. App templates in the
catalog use the same trust model: `trusted: true` templates carry a verifiable signature;
community templates show a warning until explicitly trusted by the administrator.

## Timer

`systemd/wrexr-updater.timer` runs `wrexr-update.service` daily with a random delay. It only
checks by default; installation requires an explicit action in the UI or CLI. The UI shows a
badge when an update is available.
