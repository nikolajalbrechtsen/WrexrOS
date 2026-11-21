#!/usr/bin/env bash
# WrexrOS release updater: check, verify (SHA256 + optional GPG), install with atomic swap and rollback.
set -Eeuo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="${WREXR_VERSION_FILE:-$(cd -- "$SCRIPT_DIR/.." && pwd)/VERSION}"
CHECKER="$SCRIPT_DIR/check-update.mjs"
VERIFIER="$SCRIPT_DIR/verify-release.mjs"
DEFAULT_REPO_API='https://api.github.com/repos/nikolajalbrechtsen/WrexrOS/releases/latest'
REPO_API="${WREXR_REPO_API:-$DEFAULT_REPO_API}"
TRUSTED_KEY="${WREXR_TRUSTED_KEY:-/etc/wrexr/trusted-updates.gpg}"
INSTALL_ROOT="${WREXR_INSTALL_ROOT:-/opt/wrexr}"
BACKUP_ROOT="${WREXR_BACKUP_ROOT:-/opt/wrexr-backups}"
AUDIT_LOG="${WREXR_AUDIT_LOG:-/var/log/wrexr/audit.log}"
SERVICE="${WREXR_SERVICE:-wrexrd}"
CHANNEL="${WREXR_CHANNEL:-stable}"
TIMEOUT_MS="${WREXR_TIMEOUT_MS:-10000}"

CHECK_ONLY=0
DRY_RUN=0
FORCE=0
ASSUME_YES=0
VERIFY_ONLY=0
TARGET_VERSION=''
ASSET_ARG=''
SIG_ARG=''
WORK_DIR=''
SWAPPED=0
BACKUP_DIR=''
STAGING_DIR=''

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

json_escape() {
  local value="${1//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  printf '%s' "$value"
}

audit() {
  local action="$1" resource="$2" success="$3" detail="${4:-}"
  mkdir -p -- "$(dirname -- "$AUDIT_LOG")" 2>/dev/null || true
  printf '{"time":"%s","actor":"wrexr-update","action":"%s","resource":"%s","source":"local","success":%s,"detail":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$action")" "$(json_escape "$resource")" \
    "$success" "$(json_escape "$detail")" >> "$AUDIT_LOG" 2>/dev/null \
    || log "WARNING: could not write audit event to $AUDIT_LOG"
}

usage() {
  cat <<'EOF'
Usage: wrexr-update.sh [options]
  --check                 Check for a newer release and exit
  --install [VERSION]     Install latest release or a specific tag
  --verify-only ASSET SIG Verify a local asset (SHA256SUMS next to asset)
  --force                 Install even if the version is not newer
  --dry-run               Print the plan without downloading or changing anything
  --yes                   Skip the confirmation prompt
  --channel stable|beta   Release channel (default: stable)
  --timeout MS            HTTP timeout for metadata requests
  --help                  Show this help

Environment: WREXR_REPO_API, WREXR_CHANNEL, WREXR_TIMEOUT_MS, WREXR_TRUSTED_KEY,
WREXR_ASSET_PATTERN, WREXR_INSTALL_ROOT, WREXR_BACKUP_ROOT, WREXR_AUDIT_LOG,
WREXR_SERVICE, WREXR_SHA256SUMS, GITHUB_TOKEN, WREXR_INSECURE_HTTP.
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check) CHECK_ONLY=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --force) FORCE=1; shift ;;
      --yes|-y) ASSUME_YES=1; shift ;;
      --install)
        shift
        if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then TARGET_VERSION="$1"; shift; fi
        ;;
      --verify-only)
        VERIFY_ONLY=1; shift
        ASSET_ARG="${1:-}" || die '--verify-only requires ASSET SIG'
        [[ -n "$ASSET_ARG" ]] || die '--verify-only requires ASSET SIG'
        shift || true
        if [[ $# -gt 0 && ! "$1" =~ ^- ]]; then SIG_ARG="$1"; shift; fi
        ;;
      --channel)
        shift
        CHANNEL="${1:-}" || die '--channel requires stable or beta'
        [[ "$CHANNEL" == stable || "$CHANNEL" == beta ]] || die '--channel must be stable or beta'
        shift
        ;;
      --timeout)
        shift
        TIMEOUT_MS="${1:-}" || die '--timeout requires milliseconds'
        [[ "$TIMEOUT_MS" =~ ^[0-9]+$ ]] || die '--timeout must be milliseconds'
        shift
        ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
  done
}

require_root() {
  if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
    die "root privileges are required for installation (run with sudo)"
  fi
}

confirm() {
  if [[ $ASSUME_YES -eq 1 || $DRY_RUN -eq 1 ]]; then return 0; fi
  if [[ ! -t 0 ]]; then die "non-interactive install requires --yes"; fi
  local reply=''
  read -r -p "Apply this update? [y/N] " reply || die "confirmation aborted"
  [[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]] || die "aborted by user"
}

release_api_base() {
  local clean="${REPO_API%/}"
  if [[ "$clean" == */releases/latest ]]; then
    printf '%s' "${clean%/releases/latest}"
  else
    printf '%s' "$clean"
  fi
}

release_url() {
  if [[ -n "$TARGET_VERSION" ]]; then
    [[ "$TARGET_VERSION" =~ ^[A-Za-z0-9._+:-]+$ ]] || die "invalid version tag: $TARGET_VERSION"
    printf '%s/releases/tags/%s' "$(release_api_base)" "$TARGET_VERSION"
  else
    printf '%s' "$REPO_API"
  fi
}

fetch_metadata() {
  local url="$1"
  local -a args=(-fsSL --connect-timeout 10 --max-time 60 --retry 3 --retry-delay 2)
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H 'Accept: application/vnd.github+json')
  else
    args+=(-H 'Accept: application/vnd.github+json' -H 'User-Agent: wrexr-update')
  fi
  curl "${args[@]}" "$url" || die "cannot fetch release metadata from $url (network or rate limit)"
}

run_check() {
  local -a args=("$CHECKER" --channel "$CHANNEL" --timeout "$TIMEOUT_MS")
  [[ $DRY_RUN -eq 0 ]] || args+=(--json)
  node "${args[@]}" || die "update check failed (exit $?)"
}

check_update_available() {
  local json
  json="$(node "$CHECKER" --channel "$CHANNEL" --timeout "$TIMEOUT_MS" --json)" || return 0
  node --input-type=module - "$json" <<'NODE'
try {
  const data = JSON.parse(process.argv[2] || '{}');
  process.stdout.write(data.updateAvailable ? 'yes' : 'no');
} catch {
  process.stdout.write('no');
}
NODE
}

download_asset() {
  local url="$1" destination="$2"
  [[ -n "$url" ]] || die "missing download URL for $destination"
  local -a args=(-fsSL --connect-timeout 10 --max-time 600 --retry 3 --retry-delay 2 -o "$destination")
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    args+=(-H "Authorization: Bearer ${GITHUB_TOKEN}" -H 'Accept: application/octet-stream')
  fi
  curl "${args[@]}" "$url" || die "download failed: $url"
}

verify_assets() {
  local asset="$1" sums="$2" sig="${3:-}"
  local -a args=("$VERIFIER" "$asset" "$sums")
  if [[ -n "$sig" ]]; then
    args+=("$sig")
  elif [[ -f "$TRUSTED_KEY" ]]; then
    die "refusing unsigned update: signing key $TRUSTED_KEY is configured"
  fi
  if [[ -f "$TRUSTED_KEY" ]]; then
    args+=(--keyring "$TRUSTED_KEY" --require-signature)
    [[ -n "$sig" ]] || die "missing detached signature for SHA256SUMS"
  fi
  node "${args[@]}" || die "release verification failed"
}

rollback() {
  if [[ $SWAPPED -eq 1 && -n "$BACKUP_DIR" && -d "$BACKUP_DIR" ]]; then
    log "rolling back to $BACKUP_DIR"
    if [[ -d "$INSTALL_ROOT" ]]; then
      mv -- "$INSTALL_ROOT" "${INSTALL_ROOT}.failed.$$" 2>/dev/null || true
    fi
    mv -- "$BACKUP_DIR" "$INSTALL_ROOT" || log "CRITICAL: manual rollback required from $BACKUP_DIR"
    SWAPPED=0
  fi
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then rollback; fi
  if [[ -n "$STAGING_DIR" && -d "$STAGING_DIR" ]]; then rm -rf -- "$STAGING_DIR"; fi
  if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then rm -rf -- "$WORK_DIR"; fi
  return "$status"
}

install_asset() {
  local asset="$1" name="$2"
  require_root
  confirm
  local extension="${name##*.}"
  local timestamp
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

  case "$extension" in
    deb)
      if [[ $DRY_RUN -eq 1 ]]; then
        log "would install Debian package $name with dpkg -i"
      else
        dpkg -i -- "$asset" || { audit 'update.install' "$name" false 'dpkg failed'; die "dpkg installation failed"; }
      fi
      ;;
    tar|tgz|gz|xz|zst)
      WORK_DIR="$(mktemp -d /tmp/wrexr-update.XXXXXX)"
      STAGING_DIR="${INSTALL_ROOT}.new.$$"
      BACKUP_DIR="$BACKUP_ROOT/wrexr-$timestamp"
      if [[ $DRY_RUN -eq 1 ]]; then
        log "would extract $name into $STAGING_DIR and atomically swap $INSTALL_ROOT"
        log "backup path: $BACKUP_DIR"
      else
        rm -rf -- "$STAGING_DIR"
        mkdir -p -- "$STAGING_DIR" "$(dirname -- "$BACKUP_DIR")"
        tar -xf "$asset" -C "$STAGING_DIR" --strip-components=1
        [[ -d "$STAGING_DIR" ]] || die "archive did not contain a rootfs directory"
        if [[ -d "$INSTALL_ROOT" ]]; then
          mv -- "$INSTALL_ROOT" "$BACKUP_DIR"
        fi
        mv -- "$STAGING_DIR" "$INSTALL_ROOT" || die "atomic swap failed"
        SWAPPED=1
        STAGING_DIR=''
        log "installed into $INSTALL_ROOT; backup at ${BACKUP_DIR:-(none)}"
      fi
      ;;
    *) die "unsupported release asset type: $name" ;;
  esac

  if [[ $DRY_RUN -eq 1 ]]; then
    log "would restart $SERVICE and write an audit event"
  else
    if ! systemctl restart "$SERVICE"; then
      audit 'update.restart' "$SERVICE" false 'restart failed'
      die "failed to restart $SERVICE (rollback is available via $BACKUP_DIR)"
    fi
    audit 'update.install' "$name" true "version=${TARGET_VERSION:-latest} channel=$CHANNEL"
    log "update complete; rollback path: ${BACKUP_DIR:-dpkg history}"
  fi
}

main() {
  parse_args "$@"
  trap cleanup EXIT
  trap 'log "ERROR: failed at line $LINENO"' ERR

  if [[ $VERIFY_ONLY -eq 1 ]]; then
    [[ -f "$ASSET_ARG" ]] || die "asset not found: $ASSET_ARG"
    local sums="${WREXR_SHA256SUMS:-$(dirname -- "$ASSET_ARG")/SHA256SUMS}"
    [[ -f "$sums" ]] || die "SHA256SUMS not found: $sums"
    verify_assets "$ASSET_ARG" "$sums" "$SIG_ARG"
    log 'verification succeeded'
    audit 'update.verify' "$(basename -- "$ASSET_ARG")" true ''
    return 0
  fi

  if [[ $CHECK_ONLY -eq 1 ]]; then
    [[ -f "$VERSION_FILE" ]] || die "VERSION file not found: $VERSION_FILE"
    run_check
    return 0
  fi

  [[ -f "$CHECKER" && -f "$VERIFIER" ]] || die "updater scripts missing in $SCRIPT_DIR"
  [[ -f "$VERSION_FILE" ]] || die "VERSION file not found: $VERSION_FILE"
  log "current version: $(<"$VERSION_FILE")"
  log "channel: $CHANNEL"

  if [[ -z "$TARGET_VERSION" && $FORCE -eq 0 && "$(check_update_available)" == 'no' ]]; then
    log 'already up to date; use --force to reinstall'
    return 0
  fi

  local metadata asset_info asset_url asset_name sums_url sig_url
  metadata="$(fetch_metadata "$(release_url)")"
  asset_info="$(WREXR_ASSET_PATTERN="${WREXR_ASSET_PATTERN:-}" node --input-type=module - "$metadata" <<'NODE'
const release = JSON.parse(process.argv[2] || '{}');
const assets = Array.isArray(release.assets) ? release.assets : [];
const archMap = { x64: 'amd64', arm64: 'arm64', arm: 'armv7l', ia32: 'i386' };
const os = process.platform;
const arch = archMap[process.arch] || process.arch;
const pattern = process.env.WREXR_ASSET_PATTERN || '';
const download = (asset) => String(asset.browser_download_url || asset.url || '');
const byName = (name) => assets.find((asset) => String(asset.name || '').toLowerCase() === name.toLowerCase());
const bundle = pattern
  ? assets.find((asset) => new RegExp(pattern, 'i').test(String(asset.name || '')))
  : assets.find((asset) => {
      const name = String(asset.name || '').toLowerCase();
      return name.endsWith('.deb') && name.includes(arch)
        || /\.tar(\.gz|\.xz|\.zst)?$/.test(name) && name.includes(os) && name.includes(arch);
    });
const sums = byName('SHA256SUMS');
const sig = byName('SHA256SUMS.sig') || byName('SHA256SUMS.asc');
if (!bundle) { process.stderr.write('no matching bundle asset; set WREXR_ASSET_PATTERN\n'); process.exit(1); }
if (!sums) { process.stderr.write('release has no SHA256SUMS\n'); process.exit(1); }
process.stdout.write([download(bundle), String(bundle.name), download(sums), sig ? download(sig) : ''].join('\t'));
NODE
)" || die "could not select release assets"

  IFS=$'\t' read -r asset_url asset_name sums_url sig_url <<< "$asset_info"
  IFS=$'\n\t'
  [[ -n "$asset_url" ]] || die 'release asset URL is empty'
  log "selected asset: $asset_name"

  if [[ -f "$TRUSTED_KEY" && -z "$sig_url" ]]; then
    die "refusing unsigned update: signing key $TRUSTED_KEY is configured but release has no signature"
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    log "dry run: would download $asset_name, SHA256SUMS${sig_url:+, signature}, verify, then install to $INSTALL_ROOT"
    install_asset "$asset_name" "$asset_name"
    return 0
  fi

  WORK_DIR="$(mktemp -d /tmp/wrexr-update.XXXXXX)"
  local asset_path="$WORK_DIR/$asset_name" sums_path="$WORK_DIR/SHA256SUMS" sig_path=''
  download_asset "$asset_url" "$asset_path"
  download_asset "$sums_url" "$sums_path"
  if [[ -n "$sig_url" ]]; then
    sig_path="$WORK_DIR/SHA256SUMS.sig"
    download_asset "$sig_url" "$sig_path"
  fi
  verify_assets "$asset_path" "$sums_path" "$sig_path"
  install_asset "$asset_path" "$asset_name"
}

main "$@"
