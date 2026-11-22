# WrexrOS updater

Three dependency-free utilities for release checks, verification and installation.

| File | Purpose |
| --- | --- |
| `check-update.mjs` | Queries GitHub releases and prints `{current,latest,updateAvailable,releaseUrl,publishedAt,assets}` |
| `verify-release.mjs` | Verifies a local asset against `SHA256SUMS` and an optional detached GPG signature |
| `wrexr-update.sh` | Orchestrates check → download → verify → install → restart → audit, with rollback |

## Check

```sh
node check-update.mjs                     # human output
node check-update.mjs --json              # automation
node check-update.mjs --channel beta      # include prereleases
node check-update.mjs --quiet             # no output; exit status only
node check-update.mjs --timeout 20000     # HTTP timeout in milliseconds (default 10000)
```

The current version is read from `../VERSION`. The default endpoint is
`https://api.github.com/repos/nikolajalbrechtsen/WrexrOS/releases/latest`; override it with
`WREXR_REPO_API`. `GITHUB_TOKEN` is sent as a bearer token to avoid anonymous rate limits.
Network failures, invalid responses and rate limits exit with code **2** and a clear error on
stderr (JSON on stderr when `--json` is used). A successful check exits 0 whether or not an update
exists; read `updateAvailable` from the JSON payload.

Channels:

* `stable` uses `/releases/latest`.
* `beta` also queries `/releases?per_page=20` and picks the highest semver among stable and
  prerelease tags (for example `0.2.0-beta.1` beats `0.1.0`).

## Signing model

1. Every release publishes `SHA256SUMS` and, when a signing key exists, `SHA256SUMS.asc`
   (detached signature over the checksums file).
2. The updater always verifies the asset's SHA256 hash.
3. If `/etc/wrexr/trusted-updates.gpg` (or `WREXR_TRUSTED_KEY`) exists, the detached signature
   **must** be present and valid. Unsigned updates are refused in that case.
4. Without a configured key, checksum verification still applies, but unsigned updates are allowed
   with a warning path. Enrolling a signing key is strongly recommended.

Manual verification:

```sh
node verify-release.mjs WrexrOS-0.1.5-linux-amd64.tar.gz SHA256SUMS SHA256SUMS.asc \
  --keyring /etc/wrexr/trusted-updates.gpg --require-signature
```

`verify-release.mjs` exits 0 on success and 1 on any failure (hash mismatch, missing entry, bad
signature or GPG error). GPG is invoked through `execFile('gpg', …, {shell:false})` with a fixed
allowlisted binary name; no shell interpolation is used.

## Install flow

```sh
sudo ./wrexr-update.sh --check
sudo ./wrexr-update.sh --install              # latest, with confirmation
sudo ./wrexr-update.sh --install v0.2.0 --yes # specific tag, non-interactive
sudo ./wrexr-update.sh --install --dry-run    # print the plan only
sudo ./wrexr-update.sh --install --force      # reinstall/downgrade explicitly
sudo ./wrexr-update.sh --verify-only ./WrexrOS-0.1.5-linux-amd64.tar.gz ./SHA256SUMS.asc
```

`--verify-only` takes the asset and an optional detached signature; `SHA256SUMS` is read from the
asset's directory unless `WREXR_SHA256SUMS` overrides it.

The installer:

1. Checks the version and selects a platform asset (override with `WREXR_ASSET_PATTERN`, a regex
   matched against asset names).
2. Downloads the bundle, `SHA256SUMS` and signature using `curl` with connect/max timeouts and
   retries into a temporary directory.
3. Verifies SHA256 and, when configured, GPG signature.
4. Installs a `.deb` with `dpkg -i`, or extracts a rootfs tarball into a staging directory and
   atomically swaps `/opt/wrexr` after moving the old tree to `/opt/wrexr-backups/<timestamp>`.
5. Restarts `wrexrd` with `systemctl` and appends a JSON audit event to
   `/var/log/wrexr/audit.log`.

If any step after the swap fails, the previous tree is moved back automatically. The log prints
the backup path; manual rollback is:

```sh
sudo systemctl stop wrexrd
sudo mv /opt/wrexr /opt/wrexr.failed
sudo mv /opt/wrexr-backups/<timestamp> /opt/wrexr
sudo systemctl start wrexrd
```

The script uses `set -Eeuo pipefail`, quotes all paths, never uses `eval`, and prompts for
confirmation unless `--yes` or `--dry-run` is given. Non-interactive installs without `--yes` fail
closed.

## Automation

```sh
#!/usr/bin/env bash
set -euo pipefail
export GITHUB_TOKEN="${GITHUB_TOKEN:-}"
export WREXR_CHANNEL=stable
export WREXR_TRUSTED_KEY=/etc/wrexr/trusted-updates.gpg

if ! node /opt/wrexr/updater/check-update.mjs --json > /tmp/wrexr-update.json; then
  echo 'update check failed' >&2
  exit 2
fi
if node -pe 'JSON.parse(require("fs").readFileSync("/tmp/wrexr-update.json","utf8")).updateAvailable' | grep -q true; then
  /opt/wrexr/updater/wrexr-update.sh --install --yes
fi
```

Relevant environment variables: `WREXR_REPO_API`, `WREXR_CHANNEL`, `WREXR_TIMEOUT_MS`,
`WREXR_TRUSTED_KEY`, `WREXR_ASSET_PATTERN`, `WREXR_INSTALL_ROOT`, `WREXR_BACKUP_ROOT`,
`WREXR_AUDIT_LOG`, `WREXR_SERVICE`, `WREXR_SHA256SUMS` and `GITHUB_TOKEN`.
