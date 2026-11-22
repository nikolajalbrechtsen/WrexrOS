#!/usr/bin/env bash
# WrexrOS first-boot preparation: setup marker + self-signed TLS certificate.
# Idempotent: safe to run on every boot and to re-run manually.
set -Eeuo pipefail

readonly STATE_DIR="${WREXR_STATE_DIR:-/var/lib/wrexr}"
readonly MARKER="${STATE_DIR}/setup-complete"
# Align with core/src/config.ts defaults so wrexrd uses this certificate.
readonly TLS_DIR="${WREXR_TLS_DIR:-${STATE_DIR}/tls}"
readonly KEY_FILE="${WREXR_TLS_KEY:-${TLS_DIR}/key.pem}"
readonly CRT_FILE="${WREXR_TLS_CERT:-${TLS_DIR}/cert.pem}"
readonly CONSOLE="${WREXR_CONSOLE_SCRIPT:-/opt/wrexr/boot/wrexr-console.sh}"

log_info() { printf '[ wrexr ] %s\n' "$*" >&2; }
log_warn() { printf '[ wrexr ] WARN: %s\n' "$*" >&2; }

ensure_setup_required() {
  if [[ -e $MARKER && ${WREXR_FORCE_SETUP:-0} != 1 ]]; then
    log_info "First-boot setup already completed (${MARKER} exists)"
    return 0
  fi
  mkdir -p "$STATE_DIR"
  rm -f "$MARKER"
  log_info "First-boot setup is required: ${MARKER} is absent"
}

management_ip() {
  local ip="" dev
  if command -v ip >/dev/null 2>&1; then
    for dev in br0 vmbr0 lan0 eth0 eno1 ens18; do
      ip="$(ip -4 -o addr show dev "$dev" 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')"
      [[ -n $ip ]] && break
    done
    [[ -n $ip ]] || ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{split($4, a, "/"); print a[1]; exit}')"
  fi
  [[ -n $ip ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  printf '%s' "${ip:-127.0.0.1}"
}

generate_tls() {
  local host ip san legacy_key="/etc/wrexr/tls/wrexr.key" legacy_crt="/etc/wrexr/tls/wrexr.crt"
  host="$(hostname -s 2>/dev/null || printf 'wrexr')"
  ip="$(management_ip)"

  # Migrate certificates from the 0.1.x location when upgrading in place.
  if [[ ! -s $KEY_FILE && ! -s $CRT_FILE && -s $legacy_key && -s $legacy_crt ]]; then
    mkdir -p "$TLS_DIR"
    cp "$legacy_key" "$KEY_FILE"
    cp "$legacy_crt" "$CRT_FILE"
    log_info "Migrated TLS certificate from ${legacy_crt} to ${CRT_FILE}"
  fi

  if [[ -s $KEY_FILE && -s $CRT_FILE ]]; then
    log_info "TLS certificate already present at ${CRT_FILE}"
    return 0
  fi
  command -v openssl >/dev/null 2>&1 || { log_warn "openssl not found; cannot generate TLS certificate"; return 0; }

  san="DNS:${host},DNS:localhost"
  if [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then san="${san},IP:${ip}"; fi

  mkdir -p "$TLS_DIR"
  (umask 077; openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/O=WrexrOS/CN=${host}" \
    -addext "subjectAltName=${san}" \
    -keyout "$KEY_FILE" -out "$CRT_FILE" >/dev/null 2>&1) || { log_warn "TLS generation failed"; return 0; }
  chmod 600 "$KEY_FILE"
  chmod 644 "$CRT_FILE"
  log_info "Generated self-signed TLS certificate (${CRT_FILE}, valid 10 years)"
}

print_url() {
  if [[ -x $CONSOLE ]]; then
    bash "$CONSOLE" --print
    return 0
  fi
  local port
  port="$(sed -n 's/^[[:space:]]*port[[:space:]]*=[[:space:]]*"\{0,1\}\([0-9]\{1,5\}\)"\{0,1\}.*/\1/p' /etc/wrexr/wrexrd.toml 2>/dev/null | head -n 1)"
  [[ $port =~ ^[0-9]+$ ]] || port=8443
  printf 'WrexrOS is ready: https://%s:%s/\n' "$(management_ip)" "$port"
}

main() {
  ensure_setup_required
  generate_tls
  print_url
}

main "$@"
