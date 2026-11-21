# disk.sh - disk discovery, destructive partitioning and storage pool setup.
# Sourced by wrexr-installer.sh. Uses: run(), write_file(), append_file(), log_*(), die(),
# and the global configuration variables loaded from the validated JSON config.
#
# IMPORTANT: every sgdisk call in this file is DESTRUCTIVE. Nothing here is executed
# in --dry-run mode because all commands go through run().

declare -a DISK_PATHS=() DISK_BYTES=() DISK_HUMAN=() DISK_MODEL=()
declare -a SYSTEM_EFI_PARTS=() SYSTEM_SWAP_PARTS=() SYSTEM_ROOT_PARTS=()
declare -a STORAGE_PARTS=() CACHE_PARTS=()

disk_enumerate() {
  DISK_PATHS=(); DISK_BYTES=(); DISK_HUMAN=(); DISK_MODEL=()
  local -A bytes_map=() human_map=() model_map=()
  local name bytes type human model

  while read -r name bytes type; do
    [[ -n ${name:-} && ${type:-} == disk ]] || continue
    bytes_map["$name"]="${bytes:-0}"
  done < <(lsblk -b -d -n -o NAME,SIZE,TYPE -e loop,rom 2>/dev/null || true)

  while read -r name human model; do
    [[ -n ${name:-} ]] || continue
    human_map["$name"]="${human:-?}"
    model_map["$name"]="${model:-unknown}"
  done < <(lsblk -d -n -o NAME,SIZE,MODEL -e loop,rom 2>/dev/null || true)

  for name in "${!bytes_map[@]}"; do
    DISK_PATHS+=("/dev/$name")
    DISK_BYTES+=("${bytes_map[$name]}")
    DISK_HUMAN+=("${human_map[$name]:-?}")
    DISK_MODEL+=("${model_map[$name]:-unknown}")
  done

  # Sort by size (ascending), then by device name, so auto-selection is deterministic.
  local i j tmp
  for ((i = 0; i < ${#DISK_PATHS[@]}; i += 1)); do
    for ((j = i + 1; j < ${#DISK_PATHS[@]}; j += 1)); do
      if (( DISK_BYTES[j] < DISK_BYTES[i] )) || { (( DISK_BYTES[j] == DISK_BYTES[i] )) && [[ ${DISK_PATHS[j]} < ${DISK_PATHS[i]} ]]; }; then
        tmp=${DISK_BYTES[i]};   DISK_BYTES[i]=${DISK_BYTES[j]};   DISK_BYTES[j]=$tmp
        tmp=${DISK_HUMAN[i]};   DISK_HUMAN[i]=${DISK_HUMAN[j]};   DISK_HUMAN[j]=$tmp
        tmp=${DISK_MODEL[i]};   DISK_MODEL[i]=${DISK_MODEL[j]};   DISK_MODEL[j]=$tmp
        tmp=${DISK_PATHS[i]};   DISK_PATHS[i]=${DISK_PATHS[j]};   DISK_PATHS[j]=$tmp
      fi
    done
  done
}

disk_print_table() {
  printf '  %-4s %-26s %-10s %s\n' '#' 'DEVICE' 'SIZE' 'MODEL'
  local i
  for i in "${!DISK_PATHS[@]}"; do
    printf '  %-4s %-26s %-10s %s\n' "$((i + 1))" "${DISK_PATHS[i]}" "${DISK_HUMAN[i]}" "${DISK_MODEL[i]}"
  done
}

# Standard path: smallest disk >= 32 GiB is the system disk; every remaining disk
# becomes a data disk. Two or more data disks default to a ZFS mirror.
disk_select_standard() {
  disk_enumerate
  ((${#DISK_PATHS[@]} > 0)) || die "no disks found (check 'lsblk -d')"

  local i sys_idx=-1
  for i in "${!DISK_PATHS[@]}"; do
    if (( DISK_BYTES[i] >= 34359738368 )); then sys_idx=$i; break; fi
  done
  ((sys_idx >= 0)) || die "no disk with at least 32 GiB found"

  DISK_ROWS=()
  DISK_ROWS+=("$(printf '%s\tsystem' "${DISK_PATHS[sys_idx]}")")
  local data_count=0
  for i in "${!DISK_PATHS[@]}"; do
    [[ $i -eq $sys_idx ]] && continue
    DISK_ROWS+=("$(printf '%s\tdata' "${DISK_PATHS[i]}")")
    data_count=$((data_count + 1))
  done
  if ((data_count >= 2)); then CFG_RAID=mirror; else CFG_RAID=single; fi

  log_info "Standard layout: system=${DISK_PATHS[sys_idx]}, data disks=${data_count}, raid=${CFG_RAID}"
}

disk_confirm_wipe() {
  log_warn "DESTRUCTIVE ACTION: all existing data on these disks will be erased:"
  local row dev role wipe
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role wipe <<< "$row"
    log_warn "  - ${dev}  role=${role}  wipe=${wipe:-true}"
  done
  if ((YES)); then
    log_info "--yes supplied: skipping interactive wipe confirmation"
    return 0
  fi
  local answer=""
  read -r -p "Type 'WIPE MY DISKS' to continue: " answer || die "confirmation aborted"
  [[ $answer == "WIPE MY DISKS" ]] || die "confirmation did not match; no disk was touched"
}

# Partition suffix differs for nvme/mmc/by-id devices.
part_path() {
  local dev="$1" nr="$2"
  case "$dev" in
    */disk/by-id/*) printf '%s-part%s\n' "$dev" "$nr" ;;
    *nvme[0-9]*n[0-9]*|*mmcblk[0-9]*) printf '%sp%s\n' "$dev" "$nr" ;;
    *) printf '%s%s\n' "$dev" "$nr" ;;
  esac
}

# DESTRUCTIVE: zap and partition every disk with role=system.
disk_partition_system() {
  SYSTEM_EFI_PARTS=(); SYSTEM_SWAP_PARTS=(); SYSTEM_ROOT_PARTS=()
  local row dev role root_nr
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role _ <<< "$row"
    [[ $role == system ]] || continue

    log_info "DESTRUCTIVE: wiping partition table of system disk ${dev}"
    run sgdisk --zap-all "$dev"
    run sgdisk --clear "$dev"
    run sgdisk --new=1:0:+512M --typecode=1:EF00 "--change-name=1:EFI System" "$dev"
    run sgdisk --new=2:0:+1M   --typecode=2:EF02 "--change-name=2:BIOS Boot" "$dev"
    root_nr=4
    if [[ $CFG_SWAP == true ]]; then
      run sgdisk --new=3:0:+"$CFG_SWAP_SIZE" --typecode=3:8200 "--change-name=3:Wrexr Swap" "$dev"
    else
      root_nr=3
    fi
    run sgdisk --new="${root_nr}:0:0" --typecode="${root_nr}:8300" "--change-name=${root_nr}:Wrexr Root" "$dev"
    run partprobe "$dev" || true
    run udevadm settle || true

    SYSTEM_EFI_PARTS+=("$(part_path "$dev" 1)")
    [[ $CFG_SWAP == true ]] && SYSTEM_SWAP_PARTS+=("$(part_path "$dev" 3)")
    SYSTEM_ROOT_PARTS+=("$(part_path "$dev" "$root_nr")")
  done
  ((${#SYSTEM_ROOT_PARTS[@]} > 0)) || die "no disk with role=system was selected"
}

# DESTRUCTIVE: create the root filesystem (or pool) and mount it at $TARGET.
disk_create_root_fs() {
  log_info "Creating root filesystem: ${CFG_FS}, raid=${CFG_RAID}"
  run mkdir -p "$TARGET"
  local root_dev="${SYSTEM_ROOT_PARTS[0]}"

  case "$CFG_FS" in
    zfs)
      local -a pool=(zpool create -f -o "altroot=$TARGET" -O mountpoint=/ -O compression=zstd -O atime=off -o cachefile=/etc/zfs/zpool.cache rpool)
      if ((${#SYSTEM_ROOT_PARTS[@]} > 1)) && [[ $CFG_RAID != single ]]; then
        pool+=(mirror "${SYSTEM_ROOT_PARTS[@]}")
      else
        ((${#SYSTEM_ROOT_PARTS[@]} > 1)) && log_warn "multiple system disks with raid=single: only ${SYSTEM_ROOT_PARTS[0]} is used for rpool"
        pool+=("${SYSTEM_ROOT_PARTS[0]}")
      fi
      run "${pool[@]}"
      ;;
    btrfs)
      local -a mkfs=(mkfs.btrfs -f -L WREXR_ROOT)
      if ((${#SYSTEM_ROOT_PARTS[@]} > 1)); then mkfs+=(-d raid1 -m raid1); fi
      run "${mkfs[@]}" "${SYSTEM_ROOT_PARTS[@]}"
      run mount -o subvol=@,compress=zstd "$root_dev" "$TARGET"
      run mkdir -p "$TARGET/home" "$TARGET/var"
      run btrfs subvolume create "$TARGET/home"
      ;;
    ext4)
      if ((${#SYSTEM_ROOT_PARTS[@]} > 1)); then
        run mdadm --create /dev/md/wrexr-root --level=1 --raid-devices="${#SYSTEM_ROOT_PARTS[@]}" --name=wrexr-root "${SYSTEM_ROOT_PARTS[@]}"
        root_dev=/dev/md/wrexr-root
      fi
      run mkfs.ext4 -F -L WREXR_ROOT "$root_dev"
      run mount "$root_dev" "$TARGET"
      ;;
    *) die "unsupported filesystem: $CFG_FS" ;;
  esac

  run mkdir -p "$TARGET/boot/efi"
  run mount "${SYSTEM_EFI_PARTS[0]}" "$TARGET/boot/efi"

  local swap
  for swap in "${SYSTEM_SWAP_PARTS[@]}"; do
    run mkswap -L WREXRSWAP "$swap"
    fstab_add "$swap" none swap sw 0
  done
  fstab_add "${SYSTEM_EFI_PARTS[0]}" /boot/efi vfat "umask=0077" 2
}

# Append a stable fstab entry (resolved by UUID when the device exists).
fstab_add() {
  local dev="$1" mnt="$2" fstype="$3" opts="$4" pass="$5" uuid=""
  local source="$dev"
  if ((!DRY_RUN)); then
    uuid="$(blkid -s UUID -o value "$dev" 2>/dev/null || true)"
    [[ -n $uuid ]] && source="UUID=$uuid"
  fi
  append_file "$TARGET/etc/fstab" "${source}  ${mnt}  ${fstype}  ${opts}  0 ${pass}"
}

# DESTRUCTIVE: wipe data/parity/cache members and build the storage pool.
disk_prepare_storage() {
  STORAGE_PARTS=(); CACHE_PARTS=()
  local row dev role wipe part
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role wipe <<< "$row"
    case "$role" in
      data|parity)
        log_info "DESTRUCTIVE: wiping ${role} disk ${dev} for the storage pool"
        run sgdisk --zap-all "$dev"
        run sgdisk --clear "$dev"
        run sgdisk --new=1:0:0 --typecode=1:BF00 "--change-name=1:Wrexr Data" "$dev"
        run partprobe "$dev" || true
        part="$(part_path "$dev" 1)"
        STORAGE_PARTS+=("$part")
        ;;
      cache)
        log_info "DESTRUCTIVE: wiping cache disk ${dev}"
        run sgdisk --zap-all "$dev"
        run sgdisk --clear "$dev"
        run sgdisk --new=1:0:0 --typecode=1:BF00 "--change-name=1:Wrexr Cache" "$dev"
        run partprobe "$dev" || true
        CACHE_PARTS+=("$(part_path "$dev" 1)")
        ;;
    esac
  done

  ((${#STORAGE_PARTS[@]} > 0)) || { ((${#CACHE_PARTS[@]} > 0)) && log_warn "cache disks without data disks are ignored"; return 0; }

  local n=${#STORAGE_PARTS[@]} level=""
  case "$CFG_RAID" in
    single) level=single ;;
    mirror)
      if ((n >= 2)); then level=mirror; else log_warn "raid=mirror needs 2 disks, got $n; falling back to single"; level=single; fi ;;
    raidz1)
      if ((n >= 3)); then level=raidz1; else log_warn "raid=raidz1 needs 3 disks, got $n; falling back to mirror/single"; level=mirror; fi ;;
    raidz2)
      if ((n >= 4)); then level=raidz2; else log_warn "raid=raidz2 needs 4 disks, got $n; falling back to raidz1/mirror"; level=raidz1; fi ;;
    raidz10)
      if ((n >= 4)); then level=raidz10; else log_warn "raid=raidz10 needs 4 disks, got $n; falling back to mirror/single"; level=mirror; fi ;;
  esac

  case "$CFG_FS" in
    zfs)
      local -a spec=() i=0
      case "$level" in
        single) spec=("${STORAGE_PARTS[@]}") ;;
        mirror) spec=(mirror "${STORAGE_PARTS[@]}") ;;
        raidz1) spec=(raidz1 "${STORAGE_PARTS[@]}") ;;
        raidz2) spec=(raidz2 "${STORAGE_PARTS[@]}") ;;
        raidz10)
          while ((i + 1 < n)); do spec+=(mirror "${STORAGE_PARTS[i]}" "${STORAGE_PARTS[i + 1]}"); i=$((i + 2)); done
          if ((i < n)); then log_warn "raidz10 with odd disk count: last disk is added as a stripe"; spec+=("${STORAGE_PARTS[i]}"); fi
          ;;
      esac
      run zpool create -f -o "altroot=$TARGET" -O mountpoint=/mnt/wrexr -O compression=zstd -O atime=off tank "${spec[@]}"
      local cache
      for cache in "${CACHE_PARTS[@]}"; do
        log_info "Adding L2ARC cache device ${cache} to tank"
        run zpool add -f tank cache "$cache"
      done
      run mkdir -p "$TARGET/mnt/wrexr"
      ;;
    btrfs)
      local profile="raid1"
      case "$level" in
        raidz2) profile="raid6" ;;
        raidz10) profile="raid10" ;;
        single) profile="single" ;;
      esac
      local -a args=(-f -L WREXR_DATA -d "$profile" -m "$profile")
      if [[ $profile == single ]]; then args=(-f -L WREXR_DATA); fi
      run mkfs.btrfs "${args[@]}" "${STORAGE_PARTS[@]}"
      run mkdir -p "$TARGET/mnt/wrexr"
      run mount -o compress=zstd "${STORAGE_PARTS[0]}" "$TARGET/mnt/wrexr"
      fstab_add "${STORAGE_PARTS[0]}" /mnt/wrexr btrfs compress=zstd 2
      if ((${#CACHE_PARTS[@]} > 0)); then log_warn "btrfs does not use ZFS cache devices; cache disks are left unused"; fi
      ;;
    ext4)
      local data_dev="${STORAGE_PARTS[0]}" mdlevel="1"
      case "$level" in
        single)
          if ((n > 1)); then log_warn "ext4/single: only ${STORAGE_PARTS[0]} is used, ${#STORAGE_PARTS[@]} disk(s) unused"; fi ;;
        mirror) mdlevel=1 ;;
        raidz1) mdlevel=5 ;;
        raidz2) mdlevel=6 ;;
        raidz10) mdlevel=10 ;;
      esac
      if [[ $level != single ]] && ((n > 1)); then
        run mdadm --create /dev/md/wrexr-data --level="$mdlevel" --raid-devices="$n" --name=wrexr-data "${STORAGE_PARTS[@]}"
        data_dev=/dev/md/wrexr-data
      fi
      run mkfs.ext4 -F -L WREXR_DATA "$data_dev"
      run mkdir -p "$TARGET/mnt/wrexr"
      run mount "$data_dev" "$TARGET/mnt/wrexr"
      fstab_add "$data_dev" /mnt/wrexr ext4 defaults 2
      if ((${#CACHE_PARTS[@]} > 0)); then log_warn "ext4 does not use ZFS cache devices; cache disks are left unused"; fi
      ;;
  esac
}

# Release all mounts, pools and md arrays before reboot (safe to call twice).
disk_unmount_all() {
  log_info "Unmounting target and exporting pools"
  run umount -R "$TARGET/boot/efi" || true
  run umount -R "$TARGET" || true
  if [[ $CFG_FS == zfs ]]; then
    run zpool export tank || true
    run zpool export rpool || true
  fi
  run mdadm --stop /dev/md/wrexr-data || true
  run mdadm --stop /dev/md/wrexr-root || true
}
