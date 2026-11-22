# bootloader.sh - GRUB for UEFI and legacy BIOS, initramfs and kernel cmdline.
# Sourced by wrexr-installer.sh.

bootloader_install() {
  log_info "Installing GRUB and building initramfs"

  local root_cmdline="" cmdline opt live_cmdline="" serial_kernel="" serial_speed=115200
  local serial_unit=0 grub_terminal="console" grub_serial=""
  local -a grub_lines=()
  case "$CFG_FS" in
    zfs) root_cmdline="root=ZFS=rpool" ;;
    btrfs) root_cmdline="rootflags=subvol=@" ;;
  esac

  cmdline="quiet splash"
  for opt in "${KERNEL_OPTIONS[@]}"; do cmdline="${cmdline} ${opt}"; done

  # If the live ISO was booted over a serial console, carry that console into
  # the installed kernel and GRUB. This keeps Proxmox/noVNC, IPMI and headless
  # servers usable without making serial a requirement for VGA systems.
  live_cmdline="$(tr '\n' ' ' 2>/dev/null </proc/cmdline || true)"
  for opt in $live_cmdline; do
    case "$opt" in
      console=ttyS*)
        serial_kernel="${serial_kernel:+$serial_kernel }$opt"
        serial_unit="${opt#console=ttyS}"; serial_unit="${serial_unit%%,*}"
        [[ $serial_unit =~ ^[0-9]+$ ]] || serial_unit=0
        local candidate="${opt##*,}"
        [[ $candidate =~ ^[0-9]+$ ]] && serial_speed="$candidate"
        ;;
      console=ttyAMA*) serial_kernel="${serial_kernel:+$serial_kernel }$opt" ;;
    esac
  done
  if [[ -n $serial_kernel ]]; then
    cmdline="${cmdline} ${serial_kernel}"
    grub_terminal="console serial"
    grub_serial="GRUB_SERIAL_COMMAND=\"serial --speed=${serial_speed} --unit=${serial_unit} --word=8 --parity=no --stop=1\""
  fi

  grub_lines=(
    '# Managed by wrexr-installer.sh'
    'GRUB_DEFAULT=0'
    'GRUB_TIMEOUT=3'
    'GRUB_DISTRIBUTOR="WrexrOS"'
    "GRUB_CMDLINE_LINUX_DEFAULT=\"${cmdline}\""
    "GRUB_CMDLINE_LINUX=\"${root_cmdline}\""
    'GRUB_DISABLE_OS_PROBER=false'
    'GRUB_ENABLE_CRYPTODISK=n'
    "GRUB_TERMINAL=\"${grub_terminal}\""
  )
  if [[ -n $grub_serial ]]; then grub_lines+=("$grub_serial"); fi
  write_file "$TARGET/etc/default/grub" "$(printf '%s\n' "${grub_lines[@]}")" 644

  local efi=0
  [[ -d /sys/firmware/efi ]] && efi=1

  if ((DRY_RUN)); then
    printf '  [dry-run] chroot %q apt-get install -y grub-common grub2-common os-prober grub-pc-bin\n' "$TARGET"
    ((efi)) && printf '  [dry-run] chroot %q apt-get install -y grub-efi-amd64-bin efibootmgr\n' "$TARGET"
    printf '  [dry-run] chroot %q grub-install --target=i386-pc --boot-directory=/boot <each system disk>\n' "$TARGET"
    ((efi)) && printf '  [dry-run] chroot %q grub-install --target=x86_64-efi --efi-directory=/boot/efi --bootloader-id=WrexrOS --recheck\n' "$TARGET"
    printf '  [dry-run] chroot %q update-grub && update-initramfs -u -k all\n' "$TARGET"
    return 0
  fi

  run env DEBIAN_FRONTEND=noninteractive chroot "$TARGET" apt-get install -y --no-install-recommends \
    grub-common grub2-common os-prober grub-pc-bin
  ((efi)) && run env DEBIAN_FRONTEND=noninteractive chroot "$TARGET" apt-get install -y --no-install-recommends \
    grub-efi-amd64-bin efibootmgr

  local installed=0 row dev role efi_part efi_index=0 mountpoint
  local -a system_disks=()
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role _ <<< "$row"
    [[ $role == system ]] && system_disks+=("$dev")
  done

  for dev in "${system_disks[@]}"; do
    log_info "Installing BIOS GRUB on ${dev}"
    if run chroot "$TARGET" grub-install --target=i386-pc --boot-directory=/boot "$dev"; then
      installed=1
    else
      ((efi)) || die "BIOS grub-install failed for ${dev} and no UEFI firmware was detected"
      log_warn "BIOS grub-install failed for ${dev}; UEFI bootloader will be used"
    fi
  done

  if ((efi)); then
    for efi_part in "${SYSTEM_EFI_PARTS[@]}"; do
      mountpoint="/boot/efi"
      if ((efi_index > 0)); then
        mountpoint="/.wrexr-efi-${efi_index}"
        run mkdir -p "${TARGET}${mountpoint}"
        run chroot "$TARGET" mount "$efi_part" "$mountpoint"
      fi
      log_info "Installing UEFI GRUB on ${efi_part}"
      if run chroot "$TARGET" grub-install \
        --target=x86_64-efi \
        --efi-directory="$mountpoint" \
        --bootloader-id=WrexrOS \
        --recheck; then
        installed=1
      else
        log_warn "UEFI grub-install failed for ${efi_part}"
      fi
      if ((efi_index > 0)); then
        run chroot "$TARGET" umount "$mountpoint" || true
      fi
      efi_index=$((efi_index + 1))
    done
  fi

  ((installed == 1)) || die "no bootloader could be installed"
  run chroot "$TARGET" update-grub
  run chroot "$TARGET" update-initramfs -u -k all
}
