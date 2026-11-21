#!/usr/bin/env bash
# WrexrOS first-boot console banner.
# Writes /etc/issue.d/10-wrexr.issue (idempotently) and optionally starts a kiosk.
set -Eeuo pipefail

readonly VERSION_FILE="${WREXR_VERSION_FILE:-/etc/wrexr/version}"
readonly CONFIG_FILE="${WREXR_CONFIG_FILE:-/etc/wrexr/wrexrd.toml}"
readonly ISSUE_FILE="${WREXR_ISSUE_FILE:-/etc/issue.d/10-wrexr.issue}"

PRINT_ONLY=0
ONCE=0
KIOSK=0

log_warn() { printf '[ wrexr ] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
Usage: wrexr-console.sh [--print] [--once] [--kiosk] [--help]

  --print   Print the banner only; never write files or start the kiosk.
  --once    Write the banner and exit (never starts the kiosk).
  --kiosk   Force kiosk mode even when WREXR_KIOSK is unset.
EOF
}

parse_args() {
  while (($#)); do
    case "$1" in
      --print) PRINT_ONLY=1 ;;
      --once) ONCE=1 ;;
      --kiosk) KIOSK=1 ;;
      --help|-h) usage; exit 0 ;;
      *) log_warn "unknown option: $1" >&2; usage; exit 1 ;;
    esac
    shift
  done
}

detect_version() {
  local file value=""
  for file in "$VERSION_FILE" /opt/wrexr/VERSION /opt/wrexr/core/VERSION; do
    if [[ -r $file ]]; then
      value="$(head -n 1 "$file" | tr -d '\r\n')"
      [[ -n $value ]] && break
    fi
  done
  printf '%s' "${value:-${WREXR_VERSION:-1.0.0}}"
}

detect_ip() {
  local ip="" dev
  if command -v ip >/dev/null 2>&1; then
    # Prefer the management bridge / LAN interface, then any global address.
    for dev in br0 vmbr0 lan0 eth0 enp0s31f6 ens18 eno1; do
      ip="$(ip -4 -o addr show dev "$dev" 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')"
      [[ -n $ip ]] && break
    done
    [[ -n $ip ]] || ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')"
  fi
  if [[ -z $ip ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "${ip:-<unconfigured>}"
}

detect_port() {
  local port=""
  if [[ -r $CONFIG_FILE ]]; then
    port="$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*"\{0,1\}\([0-9]\{1,5\}\)"\{0,1\}.*/\1/p' "$CONFIG_FILE" | head -n 1)"
  fi
  if [[ ! $port =~ ^[0-9]+$ ]] || ((port < 1 || port > 65535)); then
    port="${WREXR_UI_PORT:-8443}"
  fi
  printf '%s' "$port"
}

detect_scheme() {
  local tls="true"
  if [[ -r $CONFIG_FILE ]]; then
    tls="$(sed -n 's/^[[:space:]]*tls[[:space:]]*=[[:space:]]*\([a-zA-Z]*\).*/\1/p' "$CONFIG_FILE" | head -n 1)"
    [[ -n $tls ]] || tls=true
  fi
  if [[ ${WREXR_UI_SCHEME:-} == http || ${WREXR_UI_SCHEME:-} == https ]]; then
    printf '%s' "$WREXR_UI_SCHEME"
  elif [[ $tls == false ]]; then
    printf 'http'
  else
    printf 'https'
  fi
}

# banner_text VERSION IP PORT SCHEME
banner_text() {
  local version="$1" ip="$2" port="$3" scheme="$4"
  local url="${scheme}://${ip}:${port}/"
  # The appliance console deliberately stays minimal: one URL, then the normal
  # getty login prompt. Everything else belongs in the web UI.
  printf '\033[1;36mWrexrOS %s\033[0m\n' "$version"
  printf '%s\n' "$url"
  printf '\n'
}

write_issue() {
  local content="$1" tmp dir
  dir="${ISSUE_FILE%/*}"
  if [[ ! -d $dir ]]; then
    if ! mkdir -p "$dir" 2>/dev/null; then
      log_warn "cannot create ${dir}; banner not written"
      return 0
    fi
  fi
  if [[ ! -w $dir && ! -w $ISSUE_FILE ]]; then
    log_warn "no permission to write ${ISSUE_FILE}; banner not written"
    return 0
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/wrexr-issue.XXXXXX")"
  printf '%s\n' "$content" > "$tmp"
  chmod 644 "$tmp"
  if [[ -f $ISSUE_FILE ]] && cmp -s "$tmp" "$ISSUE_FILE"; then
    rm -f "$tmp"
  else
    mv -f "$tmp" "$ISSUE_FILE"
  fi
}

start_kiosk() {
  local url="$1" browser="" bin
  for bin in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do
    if [[ -x $bin ]]; then browser="$bin"; break; fi
  done
  if [[ -z $browser ]]; then log_warn "chromium is not installed; kiosk mode unavailable"; return 0; fi
  if [[ -z ${DISPLAY:-} ]]; then log_warn "DISPLAY is unset; kiosk mode unavailable"; return 0; fi
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  log_warn "starting read-only dashboard kiosk: ${url}"
  exec "$browser" \
    --kiosk --incognito --noerrdialogs --disable-session-crashed-bubble \
    --disable-features=TranslateUI --window-size=1920,1080 \
    "$url"
}

main() {
  parse_args "$@"
  local version ip port scheme content
  version="$(detect_version)"
  ip="$(detect_ip)"
  port="$(detect_port)"
  scheme="$(detect_scheme)"
  content="$(banner_text "$version" "$ip" "$port" "$scheme")"

  if ((PRINT_ONLY)); then
    printf '%s\n' "$content"
    return 0
  fi

  write_issue "$content"
  if [[ -t 1 ]]; then printf '%s\n' "$content"; fi

  if ((KIOSK || ${WREXR_KIOSK:-0} == 1)) && ((!ONCE)); then
    start_kiosk "${scheme}://${ip}:${port}/dashboard?readonly=1"
  fi
}

main "$@"
