# bootloader.sh - GRUB for UEFI and legacy BIOS, initramfs and kernel cmdline.
# Sourced by wrexr-installer.sh.

bootloader_install() {
  log_info "Installing GRUB (EFI + BIOS) and building initramfs"

  local cmdline="quiet splash"
  local opt
  for opt in "${KERNEL_OPTIONS[@]}"; do cmdline="${cmdline} ${opt}"; done

  write_file "$TARGET/etc/default/grub" "$(printf '%s\n' \
    '# Managed by wrexr-installer.sh' \
    'GRUB_DEFAULT=0' \
    'GRUB_TIMEOUT=3' \
    'GRUB_DISTRIBUTOR="WrexrOS"' \
    "GRUB_CMDLINE_LINUX_DEFAULT=\"${cmdline}\"" \
    'GRUB_CMDLINE_LINUX=""' \
    'GRUB_DISABLE_OS_PROBER=false' \
    'GRUB_ENABLE_CRYPTODISK=n' \
    'GRUB_TERMINAL="console"')" 644

  if ((DRY_RUN)); then
    printf '  [dry-run] chroot %q apt-get install -y grub-efi-amd64 grub-pc os-prober\n' "$TARGET"
    printf '  [dry-run] chroot %q grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=WrexrOS --recheck\n' "$TARGET"
    printf '  [dry-run] chroot %q update-grub && update-initramfs -u -k all\n' "$TARGET"
    return 0
  fi

  run env DEBIAN_FRONTEND=noninteractive chroot "$TARGET" apt-get install -y --no-install-recommends \
    grub-efi-amd64 grub-pc os-prober

  run chroot "$TARGET" grub-install \
    --target=x86_64-efi \
    --efi-directory=/boot/efi \
    --bootloader-id=WrexrOS \
    --recheck

  # BIOS boot also needs a bootloader on every system disk (the 1 MiB EF02 partition).
  local row dev role
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role _ <<< "$row"
    [[ $role == system ]] || continue
    log_info "Installing BIOS GRUB on ${dev}"
    run chroot "$TARGET" grub-install --target=i386-pc --boot-directory=/boot "$dev" || \
      log_warn "BIOS grub-install failed for ${dev} (normal on GPT-only UEFI systems)"
  done

  run chroot "$TARGET" update-grub
  run chroot "$TARGET" update-initramfs -u -k all
}
