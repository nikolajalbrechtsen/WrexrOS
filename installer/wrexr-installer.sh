#!/usr/bin/env bash
# WrexrOS installer - Debian bookworm base + hypervisor/NAS stack.
# DESTRUCTIVE: this script wipes disks. Read installer/README.md before use.
set -Eeuo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Prefer the version stamped next to the installer (/opt/wrexr/VERSION in the ISO),
# then the installed system version, then a conservative fallback.
readonly WREXR_VERSION="${WREXR_VERSION:-$(cat "${SCRIPT_DIR}/../VERSION" 2>/dev/null || cat /etc/wrexr/version 2>/dev/null || echo 0.1.6)}"
readonly TARGET="${WREXR_TARGET:-/target}"
readonly VALIDATOR="${SCRIPT_DIR}/validate-config.mjs"
readonly SCHEMA="${SCRIPT_DIR}/unattended.schema.json"

DRY_RUN=0
YES=0
VERBOSE=0
ADVANCED=0
TARGET_API_MOUNTED=0
WREXR_MODE="interactive"
RAW_CONFIG=""
CONFIG_FILE=""
WORKDIR=""
WREXR_LOG_FILE="${TMPDIR:-/tmp}/wrexr-installer.log"

# ---- configuration globals (filled by read_config_globals or interactive path) ----
CFG_HOSTNAME="wrexr"
CFG_TIMEZONE="UTC"
CFG_KEYBOARD="us"
CFG_FS="zfs"
CFG_RAID="single"
CFG_SWAP="true"
CFG_SWAP_SIZE="4G"
CFG_UI_PORT="8443"
CFG_CHANNEL="stable"
CFG_REPO_URL="https://repo.wrexr.io"
CFG_DEMO="false"
CFG_FORCE="false"
CFG_PKG_SRC="/run/live/medium/wrexr/packages"
NET_MODE="dhcp"
NET_IFACE="auto"
NET_BRIDGE="br0"
NET_ADDRESS=""
NET_NETMASK=""
NET_GATEWAY=""
FW_ENABLED="true"
AUTH_PASSWORD=""

declare -a KERNEL_OPTIONS=() DISK_ROWS=() NET_DNS=() FW_PORTS=() AUTH_SSH_KEYS=()
declare -a USER_ROWS=() SHARE_ROWS=()

# ---- terminal UI ----------------------------------------------------------------
# The same installer runs on VGA, serial consoles, noVNC, SSH and CI logs.
# Colour and Unicode are capability-detected; --no-color, NO_COLOR and
# WREXR_UI_COLOR=never keep logs clean while --color forces a rich terminal.
UI_COLOR=0
UI_UNICODE=0
UI_WIDTH=80
UI_COLOR_MODE="${WREXR_UI_COLOR:-auto}"
C_RESET='' C_BOLD='' C_DIM='' C_CYAN='' C_GREEN='' C_YELLOW='' C_RED='' C_EDGE=''
BOX_TL='+' BOX_TR='+' BOX_BL='+' BOX_BR='+' BOX_H='-' UI_BULLET='*' UI_ARROW='->' UI_SEP='|'

# In full-screen TUI mode, installer chatter goes to a log file so it cannot
# overwrite the ncurses dialogs. The same text is shown on stderr in CLI mode.
ui_write() {
  # Callers pipe already-formatted text here. Use cat so percent signs in disk
  # paths or messages are never reinterpreted as printf formats, and never
  # recurse back into this function.
  if ((TUI_MODE)); then
    command cat >>"$WREXR_LOG_FILE" 2>/dev/null || true
  else
    command cat >&2 || true
  fi
}

ui_detect_width() {
  local cols=""
  if [[ -r /dev/tty ]]; then
    read -r _ cols < <(stty size 2>/dev/null </dev/tty) || true
  fi
  [[ ${cols:-} =~ ^[0-9]+$ ]] || cols="${COLUMNS:-}"
  if ! [[ ${cols:-} =~ ^[0-9]+$ ]]; then
    cols="$(tput cols 2>/dev/null || true)"
  fi
  [[ ${cols:-} =~ ^[0-9]+$ ]] || cols=80
  if ! ((cols >= 40 && cols <= 120)); then cols=80; fi
  UI_WIDTH=$cols
}

ui_init() {
  local locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" cmdline="" serial=0
  if [[ -n ${NO_COLOR:-} ]]; then UI_COLOR_MODE=never; fi
  ui_detect_width

  case "$UI_COLOR_MODE" in
    always|force|1) UI_COLOR=1 ;;
    never|off|0) UI_COLOR=0 ;;
    auto|*)
      if [[ -t 2 && ${TERM:-dumb} != dumb ]]; then UI_COLOR=1; else UI_COLOR=0; fi
      ;;
  esac

  if ((UI_COLOR)); then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
    C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m'; C_EDGE=$'\033[38;5;45m'
  else
    C_EDGE=''
  fi

  cmdline="$(tr '\n' ' ' 2>/dev/null </proc/cmdline || true)"
  case "$cmdline" in
    *console=ttyS*|*console=ttyAMA*) serial=1 ;;
  esac

  # Serial consoles and the Linux text console are safest with ASCII only.
  if ((UI_WIDTH >= 60 && serial == 0)) \
    && [[ ${TERM:-dumb} != dumb && ${TERM:-} != linux ]] \
    && [[ $locale == *UTF-8* || $locale == *utf8* ]]; then
    UI_UNICODE=1
    BOX_TL='╭' BOX_TR='╮' BOX_BL='╰' BOX_BR='╯' BOX_H='─'
    UI_BULLET='◆' UI_ARROW='→' UI_SEP='·'
  fi
  return 0
}

ui_repeat() {
  local char="$1" count="$2" out="" i
  for ((i = 0; i < count; i += 1)); do out+="$char"; done
  printf '%s' "$out"
}

ui_truncate() {
  local text="$1" max="$2"
  if ((max < 4)); then printf '%s' "${text:0:max}"; return 0; fi
  if ((${#text} > max)); then printf '%s...' "${text:0:max - 3}"; return 0; fi
  printf '%s' "$text"
}

ui_pad() {
  local text="$1" width="$2" count
  count=$((width - ${#text}))
  ((count > 0)) || return 0
  ui_repeat ' ' "$count"
}

ui_box() {
  local title subtitle inner rule
  title="$(ui_truncate "$1" "$((UI_WIDTH - 6))")"
  subtitle="$(ui_truncate "${2-}" "$((UI_WIDTH - 6))")"
  inner=$((UI_WIDTH - 4))
  rule="$(ui_repeat "$BOX_H" "$inner")"
  printf '\n%s%s%s%s%s\n' "$C_EDGE" "$BOX_TL" "$rule" "$BOX_TR" "$C_RESET" | ui_write
  printf '%s%s %s%s%s%s %s%s\n' \
    "$C_EDGE" "$BOX_H" "$C_BOLD" "$title" "$C_RESET" \
    "$(ui_pad "$title" "$((inner - 2))")" "$BOX_H" "$C_RESET" | ui_write
  if [[ -n $subtitle ]]; then
    printf '%s%s %s%s%s%s %s%s\n' \
      "$C_EDGE" "$BOX_H" "$C_DIM" "$subtitle" "$C_RESET" \
      "$(ui_pad "$subtitle" "$((inner - 2))")" "$BOX_H" "$C_RESET" | ui_write
  fi
  printf '%s%s%s%s%s\n\n' "$C_EDGE" "$BOX_BL" "$rule" "$BOX_BR" "$C_RESET" | ui_write
}

ui_section() {
  printf '\n%s%s %s%s\n' "$C_CYAN" "$UI_BULLET" "$*" "$C_RESET" | ui_write
}

ui_step() {
  local current="$1" total="$2"; shift 2
  printf '%s[%s/%s]%s %s%s%s\n' \
    "$C_CYAN" "$current" "$total" "$C_RESET" "$C_BOLD" "$*" "$C_RESET" | ui_write
  if ((TUI_MODE)); then tui_progress "$current" "$total" "$*"; fi
}

ui_kv() {
  local key="$1"; shift
  printf '  %s%-16s%s %s\n' "$C_DIM" "$key" "$C_RESET" "$*" | ui_write
}

ui_menu_item() {
  local number="$1" title="$2" description="${3-}"
  printf '  %s%s%s  %s%s%s\n' \
    "$C_CYAN" "$number" "$C_RESET" "$C_BOLD" "$title" "$C_RESET" | ui_write
  if [[ -n $description ]]; then
    printf '      %s%s%s\n' "$C_DIM" "$description" "$C_RESET" | ui_write
  fi
  return 0
}

ui_success() {
  printf '\n%s%s %s%s\n' "$C_GREEN" "$UI_BULLET" "$*" "$C_RESET" | ui_write
}

ui_firmware_label() {
  if [[ -d /sys/firmware/efi ]]; then printf 'UEFI'; else printf 'BIOS/legacy'; fi
}

ui_arch_label() {
  case "$(uname -m 2>/dev/null || printf '%s' unknown)" in
    x86_64|amd64) printf 'x86-64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *) uname -m 2>/dev/null || printf '%s' unknown ;;
  esac
}

ui_banner() {
  local mode="${1:-interactive}"
  ui_box "WREXROS INSTALLER ${WREXR_VERSION}" \
    "$(ui_firmware_label) ${UI_SEP} $(ui_arch_label) ${UI_SEP} ${mode}"
}

ui_summary() {
  local message
  ui_box 'INSTALLATION PLAN' 'Review before any disk is modified'
  ui_kv 'Target' "$TARGET"
  ui_kv 'Hostname' "$CFG_HOSTNAME"
  ui_kv 'Firmware' "$(ui_firmware_label)"
  ui_kv 'Storage' "${CFG_FS}/${CFG_RAID}, ${#DISK_ROWS[@]} disk(s)"
  ui_kv 'Network' "${NET_MODE}, interface ${NET_IFACE}, bridge ${NET_BRIDGE}"
  ui_kv 'Management' "https://<${CFG_HOSTNAME}-ip>:${CFG_UI_PORT}/"
  if ((TUI_MODE)); then
    message="Installation plan\n\n"
    message+="Target:      ${TARGET}\n"
    message+="Hostname:    ${CFG_HOSTNAME}\n"
    message+="Firmware:    $(ui_firmware_label)\n"
    message+="Storage:     ${CFG_FS}/${CFG_RAID}, ${#DISK_ROWS[@]} disk(s)\n"
    message+="Network:     ${NET_MODE}, interface ${NET_IFACE}, bridge ${NET_BRIDGE}\n"
    message+="Management:  https://<${CFG_HOSTNAME}-ip>:${CFG_UI_PORT}/\n\n"
    message+="No disk has been modified yet."
    tui_msgbox "$message" || true
  fi
}

# ---- logging and error handling -------------------------------------------------
log_info()  { printf '%s%s wrexr%s %s\n' "$C_GREEN" "$UI_BULLET" "$C_RESET" "$*" | ui_write; }
log_warn()  { printf '%s%s warn%s %s\n' "$C_YELLOW" "$UI_BULLET" "$C_RESET" "$*" | ui_write; }
log_error() { printf '%s%s error%s %s\n' "$C_RED" "$UI_BULLET" "$C_RESET" "$*" | ui_write; }
die() {
  if ((TUI_MODE)); then tui_error "$*"; fi
  log_error "$*"
  exit 1
}

on_error() {
  local line="$1"
  log_error "installation failed at line ${line}"
  if declare -F disk_release_resources >/dev/null 2>&1; then
    disk_release_resources || true
  fi
  log_warn "Rollback hint (run manually, only if a partial install was made):"
  log_warn "  umount -R ${TARGET}/boot/efi 2>/dev/null || true"
  log_warn "  umount -R ${TARGET} 2>/dev/null || true"
  log_warn "  zpool export tank 2>/dev/null || true; zpool export rpool 2>/dev/null || true"
  log_warn "  mdadm --stop /dev/md/wrexr-data /dev/md/wrexr-root 2>/dev/null || true"
  log_warn "Data on disks that were already wiped cannot be recovered."
}
trap 'on_error "$LINENO"' ERR

cmd_string() {
  local out=""
  printf -v out '%q ' "$@"
  printf '%s' "${out% }"
}

# Every external command with side effects goes through run() / write_file().
run() {
  if ((DRY_RUN)); then
    printf '  [dry-run] %s\n' "$(cmd_string "$@")" | ui_write
    return 0
  fi
  if ((VERBOSE)); then printf '  [run] %s\n' "$(cmd_string "$@")" | ui_write; fi
  if ((TUI_MODE)); then
    "$@" >>"$WREXR_LOG_FILE" 2>&1
  else
    "$@"
  fi
}

write_file() {
  local path="$1" content="$2" mode="${3-}" mode_note=""
  if [[ -n $mode ]]; then mode_note=" (mode ${mode})"; fi
  if ((DRY_RUN)); then
    printf '  [dry-run] write %s bytes to %q%s\n' "${#content}" "$path" "$mode_note" | ui_write
    return 0
  fi
  run mkdir -p -- "$(dirname -- "$path")"
  printf '%s\n' "$content" > "$path"
  if [[ -n $mode ]]; then run chmod "$mode" "$path"; fi
}

append_file() {
  local path="$1" content="$2"
  if ((DRY_RUN)); then
    printf '  [dry-run] append text to %q\n' "$path" | ui_write
    return 0
  fi
  run mkdir -p -- "$(dirname -- "$path")"
  printf '%s\n' "$content" >> "$path"
}

# Usage: chroot_script LABEL [ENV=VALUE ...] <<'EOS' ... EOS
# The heredoc is static; values are passed as environment variables, never eval'd.
chroot_script() {
  local label="$1" script
  shift
  script="$(cat)"
  if ((DRY_RUN)); then
    printf '  [dry-run] chroot %q /usr/bin/env <vars> /bin/bash -s   # %s\n' "$TARGET" "$label" | ui_write
    printf '%s\n' "$script" | sed 's/^/      | /' | ui_write
    return 0
  fi
  if ((VERBOSE)); then printf '  [run] chroot script: %s\n' "$label" | ui_write; fi
  if ((TUI_MODE)); then
    printf '%s\n' "$script" | chroot "$TARGET" /usr/bin/env "$@" /bin/bash -s >>"$WREXR_LOG_FILE" 2>&1
  else
    printf '%s\n' "$script" | chroot "$TARGET" /usr/bin/env "$@" /bin/bash -s
  fi
}

# ---- validated-config readers ---------------------------------------------------
cfg_get() {
  local key="$1" default="${2-}"
  node -e '
const fs = require("node:fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const v = process.argv[2].split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
if (v === undefined || v === null) process.stdout.write(process.argv[3]);
else if (Array.isArray(v)) process.stdout.write(v.map((x) => String(x)).join("\n"));
else if (typeof v === "object") process.stdout.write(JSON.stringify(v));
else process.stdout.write(String(v));
' "$CONFIG_FILE" "$key" "$default"
}

cfg_array() {
  local key="$1"
  node -e '
const fs = require("node:fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const v = process.argv[2].split(".").reduce((a, k) => (a == null ? undefined : a[k]), o);
if (Array.isArray(v)) for (const x of v) process.stdout.write(String(x) + "\n");
' "$CONFIG_FILE" "$key"
}

cfg_rows() {
  local key="$1"; shift
  node -e '
const fs = require("node:fs");
const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const arr = process.argv[2].split(".").reduce((a, k) => (a == null ? undefined : a[k]), o) || [];
const fields = process.argv.slice(3);
for (const row of arr) {
  process.stdout.write(fields.map((f) => {
    const v = row[f];
    if (v === undefined || v === null) return "";
    return Array.isArray(v) ? v.join("|") : String(v);
  }).join("\t") + "\n");
}
' "$CONFIG_FILE" "$key" "$@"
}

validate_config_file() {
  local raw="$1"
  [[ -f $raw ]] || die "config file not found: ${raw}"
  command -v node >/dev/null || die "Node.js is required to validate the configuration"
  if [[ -z $WORKDIR ]]; then WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/wrexr-install.XXXXXX")"; fi
  CONFIG_FILE="${WORKDIR}/config.normalized.json"
  (umask 077; : > "$CONFIG_FILE")
  log_info "Validating ${raw} against ${SCHEMA}"
  if ! node "$VALIDATOR" "$raw" --schema "$SCHEMA" --output "$CONFIG_FILE" --quiet; then
    die "configuration validation failed"
  fi
}

read_config_globals() {
  CFG_HOSTNAME="$(cfg_get hostname wrexr)"
  CFG_TIMEZONE="$(cfg_get timezone UTC)"
  CFG_KEYBOARD="$(cfg_get keyboardLayout us)"
  CFG_FS="$(cfg_get filesystem zfs)"
  CFG_RAID="$(cfg_get raid single)"
  CFG_SWAP="$(cfg_get swap true)"
  CFG_SWAP_SIZE="$(cfg_get swapSize 4G)"
  CFG_UI_PORT="$(cfg_get uiPort 8443)"
  CFG_CHANNEL="$(cfg_get updateChannel stable)"
  CFG_REPO_URL="$(cfg_get repoUrl https://repo.wrexr.io)"
  CFG_DEMO="$(cfg_get demoMode false)"
  CFG_FORCE="$(cfg_get force false)"
  CFG_PKG_SRC="$(cfg_get packageSource /run/live/medium/wrexr/packages)"
  NET_MODE="$(cfg_get network.mode dhcp)"
  NET_IFACE="$(cfg_get network.interface auto)"
  NET_BRIDGE="$(cfg_get network.bridge br0)"
  NET_ADDRESS="$(cfg_get network.address '')"
  NET_NETMASK="$(cfg_get network.netmask '')"
  NET_GATEWAY="$(cfg_get network.gateway '')"
  FW_ENABLED="$(cfg_get network.firewall.enabled true)"
  AUTH_PASSWORD="$(cfg_get auth.password '')"

  mapfile -t KERNEL_OPTIONS < <(cfg_array kernelOptions)
  mapfile -t NET_DNS < <(cfg_array network.dns)
  mapfile -t FW_PORTS < <(cfg_array network.firewall.allowTcp)
  mapfile -t AUTH_SSH_KEYS < <(cfg_array auth.sshKeys)
  mapfile -t DISK_ROWS < <(cfg_rows disks path role wipe)
  mapfile -t USER_ROWS < <(cfg_rows users name groups shell sshKeys password)
  mapfile -t SHARE_ROWS < <(cfg_rows shares name protocol path readOnly recycle users)

  if ((${#FW_PORTS[@]} == 0)); then FW_PORTS=(22 "$CFG_UI_PORT"); fi
  ((${#DISK_ROWS[@]} > 0)) || die "no disks configured"
}

# ---- interactive configuration --------------------------------------------------
prompt_default() {
  local prompt="$1" def="${2-}" answer=""
  printf '%s%s%s %s' "$C_CYAN" "$UI_ARROW" "$C_RESET" "$prompt" | ui_write
  if [[ -n $def ]]; then printf ' [%s]' "$def" | ui_write; fi
  printf '%s:%s ' "$C_DIM" "$C_RESET" | ui_write
  IFS= read -r answer || true
  printf '%s' "${answer:-$def}"
}

prompt_secret() {
  local prompt="$1" answer=""
  printf '%s: ' "$prompt" | ui_write
  IFS= read -rs answer || true
  printf '\n' | ui_write
  [[ $answer != *:* && $answer != *$'\n'* ]] || die "passwords must not contain ':' or newlines"
  printf '%s' "$answer"
}

# Shared prompts for both the full-screen and line-oriented interfaces.
ask_input() {
  if ((TUI_MODE)); then tui_input "$@"; else prompt_default "$@"; fi
}

ask_secret() {
  if ((TUI_MODE)); then tui_password "$1"; else prompt_secret "$1"; fi
}

interactive_standard() {
  ui_section 'Detecting available disks'
  disk_select_standard
  if ((TUI_MODE)); then
    local i message=$'Detected disks:\n\n'
    for i in "${!DISK_PATHS[@]}"; do
      message+=$'  '"${DISK_PATHS[i]}  ${DISK_HUMAN[i]}  ${DISK_MODEL[i]}"$'\n'
    done
    message+=$'\n'"System disk: ${DISK_ROWS[0]%%$'\t'*}"$'\n'
    message+="Filesystem: zfs / RAID: ${CFG_RAID}"$'\n'
    message+=$'\n'"DHCP, UTC, keyboard us, management port 8443."
    tui_msgbox "$message" || true
  else
    disk_print_table
  fi
  CFG_HOSTNAME="wrexr"; CFG_TIMEZONE="UTC"; CFG_KEYBOARD="us"
  CFG_FS="zfs"; CFG_SWAP="true"; CFG_SWAP_SIZE="4G"
  NET_MODE="dhcp"; NET_IFACE="auto"; NET_BRIDGE="br0"
  CFG_UI_PORT="8443"; CFG_CHANNEL="stable"
  USER_ROWS=(); SHARE_ROWS=(); KERNEL_OPTIONS=()
  ui_section 'Administrator access'
  interactive_credentials
}

interactive_advanced_tui() {
  local i role system_on data_on parity_on cache_on
  DISK_ROWS=()
  for i in "${!DISK_PATHS[@]}"; do
    if ((i == 0)); then system_on=on; data_on=off; else system_on=off; data_on=on; fi
    parity_on=off; cache_on=off
    role="$(tui_radiolist "Role for ${DISK_PATHS[i]} (${DISK_HUMAN[i]}, ${DISK_MODEL[i]})" \
      system 'System disk (root pool)' "$system_on" \
      data 'Data disk (storage pool)' "$data_on" \
      parity 'Parity disk (RAIDZ / RAID5 / RAID6)' "$parity_on" \
      cache 'Cache disk (ZFS L2ARC)' "$cache_on")" || die 'disk role selection cancelled'
    case "$role" in system|data|parity|cache) ;; *) die "invalid role: ${role}" ;; esac
    DISK_ROWS+=("$(printf '%s\t%s\ttrue' "${DISK_PATHS[i]}" "$role")")
  done

  CFG_HOSTNAME="$(tui_input 'Hostname' wrexr)" || die 'hostname entry cancelled'
  CFG_FS="$(tui_radiolist 'Root filesystem' \
    zfs 'ZFS (recommended)' on \
    btrfs 'Btrfs' off \
    ext4 'ext4 (simple)' off)" || die 'filesystem selection cancelled'
  CFG_RAID="$(tui_radiolist 'RAID level' \
    single 'Single disk' on \
    mirror 'Mirror' off \
    raidz1 'RAIDZ1 / RAID5 (3+ disks)' off \
    raidz2 'RAIDZ2 / RAID6 (4+ disks)' off \
    raidz10 'Striped mirrors (4+ disks)' off)" || die 'RAID selection cancelled'
  CFG_SWAP="$(tui_radiolist 'Create a swap partition?' \
    true 'Yes' on \
    false 'No' off)" || die 'swap selection cancelled'
  CFG_SWAP_SIZE="$(tui_input 'Swap size' 4G)" || die 'swap size entry cancelled'
  CFG_KEYBOARD="$(tui_input 'Keyboard layout' us)" || die 'keyboard entry cancelled'
  CFG_TIMEZONE="$(tui_input 'Timezone' UTC)" || die 'timezone entry cancelled'
  CFG_UI_PORT="$(tui_input 'Management UI port' 8443)" || die 'port entry cancelled'

  NET_MODE="$(tui_radiolist 'Network mode' \
    dhcp 'DHCP (automatic)' on \
    static 'Static IPv4' off)" || die 'network mode selection cancelled'
  NET_IFACE="$(tui_input 'Management interface (auto to detect)' auto)" || die 'interface entry cancelled'
  NET_BRIDGE="$(tui_input 'Bridge name' br0)" || die 'bridge entry cancelled'
  if [[ $NET_MODE == static ]]; then
    NET_ADDRESS="$(tui_input 'Static IPv4 address' 192.168.1.20)" || die 'address entry cancelled'
    NET_NETMASK="$(tui_input 'Netmask' 255.255.255.0)" || die 'netmask entry cancelled'
    NET_GATEWAY="$(tui_input 'Gateway' 192.168.1.1)" || die 'gateway entry cancelled'
    local dns
    dns="$(tui_input 'DNS servers (space separated)' 1.1.1.1)" || die 'DNS entry cancelled'
    read -r -a NET_DNS <<< "$dns"
  fi
  local kopts
  kopts="$(tui_input 'Extra kernel options (space separated)' '')" || die 'kernel options entry cancelled'
  read -r -a KERNEL_OPTIONS <<< "$kopts"
}

interactive_advanced() {
  ui_section 'Detecting available disks'
  disk_enumerate
  ((${#DISK_PATHS[@]} > 0)) || die "no disks found (check 'lsblk -d')"
  disk_print_table
  local sel="" piece idx role
  printf '  %sAssign roles: %s1=system,2=data,3=parity,4=cache%s\n' \
    "$C_DIM" "$C_CYAN" "$C_RESET" | ui_write
  sel="$(prompt_default 'Disks and roles' '')"
  [[ -n $sel ]] || die "at least one disk must be assigned"
  DISK_ROWS=()
  IFS=',' read -r -a pieces <<< "$sel"
  for piece in "${pieces[@]}"; do
    piece="${piece//[[:space:]]/}"
    [[ $piece == *=* ]] || die "invalid disk assignment: ${piece}"
    idx="${piece%%=*}"; role="${piece#*=}"
    [[ $idx =~ ^[0-9]+$ ]] || die "invalid disk number: ${idx}"
    ((idx >= 1 && idx <= ${#DISK_PATHS[@]})) || die "disk number out of range: ${idx}"
    case "$role" in system|data|parity|cache) ;; *) die "invalid role: ${role}" ;; esac
    DISK_ROWS+=("$(printf '%s\t%s\ttrue' "${DISK_PATHS[idx - 1]}" "$role")")
  done

  ui_section 'Host and network'
  CFG_HOSTNAME="$(prompt_default 'Hostname' wrexr)"
  CFG_FS="$(prompt_default 'Filesystem (zfs/btrfs/ext4)' zfs)"
  CFG_RAID="$(prompt_default 'RAID (single/mirror/raidz1/raidz2/raidz10)' single)"
  CFG_SWAP="$(prompt_default 'Create swap (true/false)' true)"
  CFG_SWAP_SIZE="$(prompt_default 'Swap size' 4G)"
  CFG_KEYBOARD="$(prompt_default 'Keyboard layout' us)"
  CFG_TIMEZONE="$(prompt_default 'Timezone' UTC)"
  CFG_UI_PORT="$(prompt_default 'Management UI port' 8443)"
  NET_MODE="$(prompt_default 'Network mode (dhcp/static)' dhcp)"
  NET_IFACE="$(prompt_default 'Management interface (auto to detect)' auto)"
  NET_BRIDGE="$(prompt_default 'Bridge name' br0)"
  if [[ $NET_MODE == static ]]; then
    NET_ADDRESS="$(prompt_default 'Static IPv4 address' 192.168.1.20)"
    NET_NETMASK="$(prompt_default 'Netmask' 255.255.255.0)"
    NET_GATEWAY="$(prompt_default 'Gateway' 192.168.1.1)"
    local dns
    dns="$(prompt_default 'DNS servers (space separated)' 1.1.1.1)"
    read -r -a NET_DNS <<< "$dns"
  fi
  local kopts
  kopts="$(prompt_default 'Extra kernel options (space separated)' '')"
  read -r -a KERNEL_OPTIONS <<< "$kopts"

  ui_section 'Administrator access'
  interactive_credentials
  interactive_users_shares
}

interactive_credentials() {
  AUTH_PASSWORD="$(ask_secret 'Root password (leave empty to use SSH keys)')"
  AUTH_SSH_KEYS=()
  if [[ -z $AUTH_PASSWORD ]]; then
    local keyfile
    keyfile="$(ask_input 'Path to SSH public key file (optional)' '')"
    if [[ -n $keyfile ]]; then
      [[ -f $keyfile ]] || die "SSH key file not found: ${keyfile}"
      mapfile -t AUTH_SSH_KEYS < "$keyfile"
    fi
  fi
  ((${#AUTH_PASSWORD} > 0 || ${#AUTH_SSH_KEYS[@]} > 0)) || \
    die "you must provide either a root password or at least one SSH public key"
}

interactive_users_shares() {
  USER_ROWS=(); SHARE_ROWS=()
  ui_section 'Optional users and shares'
  local spec="" IFS_SAVE="$IFS"
  spec="$(ask_input 'Extra users (name:groups:shell, comma separated)' '')"
  if [[ -n $spec ]]; then
    local entry name groups shell
    IFS=',' read -r -a entries <<< "$spec"
    for entry in "${entries[@]}"; do
      entry="${entry//[[:space:]]/}"
      IFS=':' read -r name groups shell <<< "$entry"
      USER_ROWS+=("$(printf '%s\t%s\t%s\t\t' "$name" "${groups//,/'|'}" "${shell:-/bin/bash}")")
    done
  fi
  spec="$(ask_input 'Shares (name:protocol:path, comma separated)' '')"
  if [[ -n $spec ]]; then
    local entry name protocol path
    IFS=',' read -r -a entries <<< "$spec"
    for entry in "${entries[@]}"; do
      entry="${entry//[[:space:]]/}"
      IFS=':' read -r name protocol path <<< "$entry"
      SHARE_ROWS+=("$(printf '%s\t%s\t%s\tfalse\ttrue\t' "$name" "$protocol" "${path:-/mnt/wrexr/data}")")
    done
  fi
  IFS="$IFS_SAVE"
}

build_interactive_json() {
  WREXR_CFG_HOST="$CFG_HOSTNAME" \
  WREXR_CFG_TZ="$CFG_TIMEZONE" \
  WREXR_CFG_KBD="$CFG_KEYBOARD" \
  WREXR_CFG_FS="$CFG_FS" \
  WREXR_CFG_RAID="$CFG_RAID" \
  WREXR_CFG_SWAP="$CFG_SWAP" \
  WREXR_CFG_SWAPSIZE="$CFG_SWAP_SIZE" \
  WREXR_CFG_PORT="$CFG_UI_PORT" \
  WREXR_CFG_NETMODE="$NET_MODE" \
  WREXR_CFG_IFACE="$NET_IFACE" \
  WREXR_CFG_BRIDGE="$NET_BRIDGE" \
  WREXR_CFG_ADDR="$NET_ADDRESS" \
  WREXR_CFG_MASK="$NET_NETMASK" \
  WREXR_CFG_GW="$NET_GATEWAY" \
  WREXR_CFG_DNS="$(printf '%s\n' "${NET_DNS[@]}")" \
  WREXR_CFG_PASSWORD="$AUTH_PASSWORD" \
  WREXR_CFG_KEYS="$(printf '%s\n' "${AUTH_SSH_KEYS[@]}")" \
  WREXR_CFG_KOPTS="$(printf '%s\n' "${KERNEL_OPTIONS[@]}")" \
  WREXR_CFG_DISKS="$(printf '%s\n' "${DISK_ROWS[@]}")" \
  WREXR_CFG_USERS="$(printf '%s\n' "${USER_ROWS[@]}")" \
  WREXR_CFG_SHARES="$(printf '%s\n' "${SHARE_ROWS[@]}")" node -e '
const e = process.env;
const lines = (v) => (v || "").split("\n").filter(Boolean);
const splitTab = (l) => l.split("\t");
const disks = lines(e.WREXR_CFG_DISKS).map((l) => {
  const f = splitTab(l);
  return { path: f[0], role: f[1], wipe: f[2] !== "false" };
});
const users = lines(e.WREXR_CFG_USERS).map((l) => {
  const f = splitTab(l);
  const o = { name: f[0], groups: (f[1] || "").split("|").filter(Boolean), shell: f[2] || "/bin/bash" };
  if (f[3]) o.sshKeys = f[3].split("|").filter(Boolean);
  if (f[4]) o.password = f[4];
  return o;
});
const shares = lines(e.WREXR_CFG_SHARES).map((l) => {
  const f = splitTab(l);
  return { name: f[0], protocol: f[1], path: f[2], readOnly: f[3] === "true", recycle: f[4] === "true", users: (f[5] || "").split("|").filter(Boolean) };
});
const network = {
  mode: e.WREXR_CFG_NETMODE,
  interface: e.WREXR_CFG_IFACE,
  bridge: e.WREXR_CFG_BRIDGE,
  firewall: { enabled: true, allowTcp: [22, Number(e.WREXR_CFG_PORT)] }
};
if (network.mode === "static") {
  network.address = e.WREXR_CFG_ADDR;
  network.netmask = e.WREXR_CFG_MASK;
  network.gateway = e.WREXR_CFG_GW;
  network.dns = lines(e.WREXR_CFG_DNS);
}
const auth = {};
if (e.WREXR_CFG_PASSWORD) auth.password = e.WREXR_CFG_PASSWORD;
if (lines(e.WREXR_CFG_KEYS).length) auth.sshKeys = lines(e.WREXR_CFG_KEYS);
const o = {
  version: 1,
  hostname: e.WREXR_CFG_HOST,
  timezone: e.WREXR_CFG_TZ,
  keyboardLayout: e.WREXR_CFG_KBD,
  filesystem: e.WREXR_CFG_FS,
  raid: e.WREXR_CFG_RAID,
  swap: e.WREXR_CFG_SWAP === "true",
  swapSize: e.WREXR_CFG_SWAPSIZE,
  uiPort: Number(e.WREXR_CFG_PORT),
  updateChannel: "stable",
  demoMode: false,
  force: true,
  kernelOptions: lines(e.WREXR_CFG_KOPTS),
  disks,
  network,
  auth,
  users,
  shares
};
process.stdout.write(JSON.stringify(o, null, 2));
'
}

run_advanced_config() {
  if ((TUI_MODE)); then
    interactive_advanced_tui
    interactive_users_shares
  else
    interactive_advanced
  fi
}

interactive_config() {
  ui_banner 'guided mode'
  local choice=""
  if ((TUI_MODE)); then
    tui_msgbox "Welcome to the WrexrOS installer.\n\nChoose Standard for automatic disks and defaults, or Advanced to configure disks, RAID, network and accounts.\n\nThe selected disks will be erased." || true
    choice="$(tui_menu 'Choose an install path' \
      1 'Standard install - automatic disks, DHCP, UTC and ZFS' \
      2 'Advanced options - disks, RAID, network, users and shares')" \
      || die "install path selection cancelled"
  else
    ui_section 'Choose an install path'
    ui_menu_item '1)' 'Standard install' \
      'Automatic disks, DHCP, UTC, ZFS and sensible defaults.'
    ui_menu_item '2)' 'Advanced options' \
      'Manual disks, filesystem, RAID, network, users and shares.'
  fi

  if ((ADVANCED)); then
    run_advanced_config
  else
    [[ -n $choice ]] || choice="$(prompt_default 'Choose an install path' 1)"
    case "$choice" in
      1) interactive_standard ;;
      2) run_advanced_config ;;
      *) die "invalid choice: ${choice}" ;;
    esac
  fi

  local raw="${WORKDIR}/interactive.json"
  (umask 077; build_interactive_json > "$raw")
  validate_config_file "$raw"
  read_config_globals
}

# ---- argument parsing / preflight ----------------------------------------------
usage() {
  cat <<EOF
Usage: wrexr-installer.sh [options]

Options:
  --interactive            Guided installation (default). Standard or advanced path.
  --advanced               Skip the guided menu and open advanced options.
  --config PATH            Unattended install using a validated JSON config.
  --unattended PATH        Alias for --config PATH.
  --dry-run                Print every command instead of executing it. No disk is touched.
  --yes                    Assume yes; required in unattended mode; skips wipe prompt.
  --verbose                Print executed commands as well as progress messages.
  --color                  Force coloured terminal output even when redirected.
  --no-color               Plain ASCII output for logs, serial consoles and scripts.
  --tui                    Force the full-screen ncurses installer interface.
  --text                   Force the line-oriented installer interface.
  --version                Print installer version and exit.
  --help                   Show this help.

Safety:
  * Disks are irreversibly wiped. Confirm device names with 'lsblk' first.
  * Unattended mode requires force=true in the config AND --yes on the command line.
  * Config files containing passwords must be mode 0600.
EOF
}

parse_args() {
  while (($#)); do
    case "$1" in
      --interactive) WREXR_MODE=interactive ;;
      --advanced) ADVANCED=1; WREXR_MODE=interactive ;;
      --config|--unattended)
        shift
        (($#)) || die "$1 requires a path"
        RAW_CONFIG="$1"; WREXR_MODE=unattended
        ;;
      --config=*) RAW_CONFIG="${1#*=}"; WREXR_MODE=unattended ;;
      --unattended=*) RAW_CONFIG="${1#*=}"; WREXR_MODE=unattended ;;
      --dry-run) DRY_RUN=1 ;;
      --yes) YES=1 ;;
      --verbose) VERBOSE=1 ;;
      --color) UI_COLOR_MODE=always ;;
      --no-color) UI_COLOR_MODE=never ;;
      --tui) WREXR_TUI=always ;;
      --text) WREXR_TUI=never ;;
      --version) printf 'wrexr-installer %s\n' "$WREXR_VERSION"; exit 0 ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

preflight_common() {
  local tool missing=0
  local -a tools=(
    lsblk findmnt losetup blkid sgdisk partprobe udevadm debootstrap node openssl
    chroot mkfs.vfat mkfs.ext4 mkswap mount umount tar mdadm
  )
  for tool in "${tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      if ((DRY_RUN)); then log_warn "tool not found (dry run continues): ${tool}"; else missing=1; log_error "required tool not found: ${tool}"; fi
    fi
  done
  ((missing == 0)) || die "install prerequisites are missing"
  if ((!DRY_RUN)) && ((EUID != 0)); then die "the installer must run as root (sudo -i)"; fi
  if ((DRY_RUN)); then log_warn "DRY RUN: no command will modify a disk or file"; fi
}

# Filesystem-specific tools are checked only after CFG_FS is known.
preflight_filesystem() {
  local fs="${1:-$CFG_FS}" tool missing=0
  local -a tools=()
  case "$fs" in
    zfs) tools+=(zpool zfs) ;;
    btrfs) tools+=(mkfs.btrfs btrfs) ;;
    ext4) ;;
    *) die "unsupported filesystem: ${fs}" ;;
  esac
  for tool in "${tools[@]}"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      if ((DRY_RUN)); then log_warn "tool not found (dry run continues): ${tool}"; else missing=1; log_error "required tool not found: ${tool}"; fi
    fi
  done
  ((missing == 0)) || die "filesystem prerequisites are missing for ${fs}"
}

main() {
  parse_args "$@"
  ui_init
  WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/wrexr-install.XXXXXX")"
  WREXR_LOG_FILE="${WORKDIR}/installer.log"
  tui_init
  if ((TUI_MODE)); then : >"$WREXR_LOG_FILE" 2>/dev/null || true; fi
  preflight_common

  if [[ $WREXR_MODE == interactive ]]; then
    interactive_config
  else
    ui_banner 'unattended mode'
    validate_config_file "$RAW_CONFIG"
    read_config_globals
    [[ $CFG_FORCE == true ]] || die "unattended config must set force:true to acknowledge disk wiping"
    ((YES)) || die "unattended installs require --yes (refusing to wipe disks without it)"
  fi

  ui_step 1 6 'Validating configuration and disks'
  preflight_filesystem "$CFG_FS"
  disk_validate_configured
  network_resolve_interface
  ui_summary
  disk_confirm_wipe

  # Order matters: partition and mount the target before debootstrap, mount the
  # API filesystems before any chroot, then write fstab after debootstrap so the
  # base conffile cannot overwrite our entries.
  ui_step 2 6 'Preparing storage and Debian base'
  disk_partition_system
  disk_create_root_fs
  base_debootstrap
  mount_target_api_fs
  disk_prepare_storage
  mdadm_register_arrays
  fstab_write

  ui_step 3 6 'Installing the WrexrOS runtime'
  base_copy_packages
  base_copy_repo
  install_node_runtime_target

  ui_step 4 6 'Configuring network and services'
  network_configure
  base_configure

  ui_step 5 6 'Installing the bootloader'
  bootloader_install

  ui_step 6 6 'Finalizing installation'
  finish_install
}

# ---- sourced implementation files ----------------------------------------------
# shellcheck source=functions/tui.sh
source "${SCRIPT_DIR}/functions/tui.sh"
# shellcheck source=functions/disk.sh
source "${SCRIPT_DIR}/functions/disk.sh"
# shellcheck source=functions/network.sh
source "${SCRIPT_DIR}/functions/network.sh"
# shellcheck source=functions/base.sh
source "${SCRIPT_DIR}/functions/base.sh"
# shellcheck source=functions/bootloader.sh
source "${SCRIPT_DIR}/functions/bootloader.sh"
# shellcheck source=functions/finish.sh
source "${SCRIPT_DIR}/functions/finish.sh"

main "$@"
