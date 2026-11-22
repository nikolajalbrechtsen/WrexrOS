# finish.sh - final state, unmount and hand-off.
# Sourced by wrexr-installer.sh.

finish_install() {
  log_info "Finishing installation"

  # A host-side copy is convenient for PXE logs; the authoritative copy lives in the target.
  write_file /run/wrexr/install-state.json \
    "$( [[ -f $TARGET/etc/wrexr/install-state.json ]] && cat "$TARGET/etc/wrexr/install-state.json" || printf '{ "status": "dry-run" }' )" 600

  disk_unmount_all

  printf '\n' | ui_write
  if declare -F ui_success >/dev/null 2>&1; then
    ui_success "WrexrOS ${WREXR_VERSION} installed to ${TARGET}"
  else
    log_info "WrexrOS ${WREXR_VERSION} installed to ${TARGET}"
  fi
  log_info "Management URL: https://<${CFG_HOSTNAME}-ip>:${CFG_UI_PORT}/"
  log_info "First boot: the setup wizard is required (/var/lib/wrexr/setup-complete is absent)."
  if ((YES)); then
    log_info "--yes supplied: not rebooting automatically. Run 'reboot' when ready."
  elif tui_yesno "Remove installation media and reboot now?"; then
    run reboot
  fi
  if ((TUI_MODE)); then
    tui_msgbox "WrexrOS ${WREXR_VERSION} installed.\n\nManagement URL: https://<${CFG_HOSTNAME}-ip>:${CFG_UI_PORT}/\n\nRemove the installation media before rebooting." || true
  fi
}
