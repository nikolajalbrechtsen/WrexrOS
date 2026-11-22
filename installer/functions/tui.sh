# tui.sh - full-screen ncurses installer dialogs.
# Sourced by wrexr-installer.sh. Uses the terminal UI globals from the main
# script and falls back to line prompts when whiptail is unavailable.
#
# Proxmox uses an ncurses installer; whiptail provides the same style of
# full-screen menus, forms, password boxes and confirmation dialogs.

TUI_MODE=0
TUI_WIDTH=70
TUI_HEIGHT=22
TUI_LIST_HEIGHT=10
TUI_RESULT_FILE="${TMPDIR:-/tmp}/wrexr-whiptail-$$.txt"

tui_available() {
  command -v whiptail >/dev/null 2>&1 || return 1
  [[ -t 0 && -t 1 && -t 2 && ${TERM:-dumb} != dumb ]] || return 1
  return 0
}

tui_init() {
  case "${WREXR_TUI:-auto}" in
    always|force|1)
      if tui_available; then
        TUI_MODE=1
      else
        TUI_MODE=0
        log_warn "full-screen installer requested but no compatible terminal was found; using text mode"
      fi
      ;;
    never|off|0) TUI_MODE=0 ;;
    auto|*)
      if tui_available; then TUI_MODE=1; else TUI_MODE=0; fi
      ;;
  esac
  TUI_WIDTH=$UI_WIDTH
  if ((TUI_WIDTH < 60)); then TUI_WIDTH=60; fi
  if ((TUI_WIDTH > 110)); then TUI_WIDTH=110; fi
  TUI_LIST_HEIGHT=10
  TUI_HEIGHT=$((TUI_LIST_HEIGHT + 12))
  return 0
}

# whiptail draws on the terminal via stderr and can write its result to a
# chosen fd. Using --output-fd keeps command substitution reliable when the
# installer's own messages are redirected to the log file in TUI mode.
tui_whiptail() {
  local rc
  : >"$TUI_RESULT_FILE"
  whiptail --title "WrexrOS ${WREXR_VERSION} Installer" --output-fd 3 "$@" 3>"$TUI_RESULT_FILE"
  rc=$?
  if ((rc != 0)); then return "$rc"; fi
  command cat "$TUI_RESULT_FILE"
  return 0
}

tui_box_height() {
  local text="$1" lines
  lines="$(printf '%s\n' "$text" | wc -l)"
  lines=$((lines + 6))
  if ((lines < 8)); then lines=8; fi
  if ((lines > TUI_HEIGHT)); then lines=$TUI_HEIGHT; fi
  printf '%s' "$lines"
}

tui_msgbox() {
  local text="$1"
  ((TUI_MODE)) || return 0
  tui_whiptail --msgbox "$text" "$(tui_box_height "$text")" "$TUI_WIDTH" || true
  return 0
}

tui_infobox() {
  local text="$1"
  ((TUI_MODE)) || return 0
  tui_whiptail --infobox "$text" 8 "$TUI_WIDTH" || true
  return 0
}

tui_yesno() {
  local text="$1"
  if ((TUI_MODE)); then
    tui_whiptail --yesno "$text" "$(tui_box_height "$text")" "$TUI_WIDTH"
    return $?
  fi
  local answer=""
  printf '%s [Y/n]: ' "$text" | ui_write
  IFS= read -r answer || return 1
  [[ -z $answer || $answer == [yY]* ]]
}

tui_menu() {
  local prompt="$1" result
  shift
  if ((TUI_MODE)); then
    result="$(tui_whiptail --menu "$prompt" "$TUI_HEIGHT" "$TUI_WIDTH" "$TUI_LIST_HEIGHT" "$@")" || return 1
  else
    local -a tags=() labels=() i=0
    while (($# >= 2)); do
      tags+=("$1"); labels+=("$2"); shift 2
      i=$((i + 1))
    done
    printf '%s\n' "$prompt" | ui_write
    for ((i = 0; i < ${#tags[@]}; i += 1)); do
      printf '  %s) %s\n' "$((i + 1))" "${labels[i]}" | ui_write
    done
    result="$(prompt_default 'Selection' "${tags[0]}")"
    if [[ $result =~ ^[0-9]+$ ]] && ((result >= 1 && result <= ${#tags[@]})); then
      result="${tags[result - 1]}"
    fi
  fi
  printf '%s' "$result"
}

tui_radiolist() {
  local prompt="$1" result
  shift
  if ((TUI_MODE)); then
    result="$(tui_whiptail --radiolist "$prompt" "$TUI_HEIGHT" "$TUI_WIDTH" "$TUI_LIST_HEIGHT" "$@")" || return 1
  else
    local -a tags=() labels=() i=0
    while (($# >= 3)); do
      tags+=("$1"); labels+=("$2"); shift 3
      i=$((i + 1))
    done
    printf '%s\n' "$prompt" | ui_write
    for ((i = 0; i < ${#tags[@]}; i += 1)); do
      printf '  %s) %s\n' "$((i + 1))" "${labels[i]}" | ui_write
    done
    result="$(prompt_default 'Selection' "${tags[0]}")"
    if [[ $result =~ ^[0-9]+$ ]] && ((result >= 1 && result <= ${#tags[@]})); then
      result="${tags[result - 1]}"
    fi
  fi
  printf '%s' "$result"
}

tui_input() {
  local prompt="$1" def="${2-}" result
  if ((TUI_MODE)); then
    result="$(tui_whiptail --inputbox "$prompt" 10 "$TUI_WIDTH" "$def")" || return 1
    printf '%s' "$result"
  else
    prompt_default "$prompt" "$def"
  fi
}

tui_password() {
  local prompt="$1" result
  if ((TUI_MODE)); then
    result="$(tui_whiptail --passwordbox "$prompt" 10 "$TUI_WIDTH")" || return 1
    printf '%s' "$result"
  else
    prompt_secret "$prompt"
  fi
}

tui_progress() {
  local current="$1" total="$2"
  shift 2
  ((TUI_MODE)) || return 0
  tui_whiptail --infobox "[${current}/${total}] $*" 8 "$TUI_WIDTH" >/dev/null 2>&1 || true
  return 0
}

tui_error() {
  ((TUI_MODE)) || return 0
  tui_msgbox "Installation error\n\n$*"
  return 0
}
