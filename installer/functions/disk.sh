# disk.sh - disk discovery, destructive partitioning and storage pool setup.
# Sourced by wrexr-installer.sh. Uses: run(), write_file(), append_file(), log_*(), die(),
# and the global configuration variables loaded from the validated JSON config.
#
# IMPORTANT: every sgdisk call in this file is DESTRUCTIVE. Nothing here is executed
# in --dry-run mode because all commands go through run().

declare -a DISK_PATHS=() DISK_BYTES=() DISK_HUMAN=() DISK_MODEL=()
declare -a SYSTEM_EFI_PARTS=() SYSTEM_SWAP_PARTS=() SYSTEM_ROOT_PARTS=()
declare -a DATA_PARTS=() PARITY_PARTS=() STORAGE_PARTS=() CACHE_PARTS=()
declare -a FSTAB_ENTRIES=()

# Mark a block device and every parent disk as unsafe. Called from disk_enumerate,
# where the associative array `unsafe` is in scope (bash dynamic scoping).
disk_mark_tree_unsafe() {
  local cur="${1#/dev/}" depth
  [[ -n $cur ]] || return 0
  for ((depth = 0; depth < 8 && -n cur; depth += 1)); do
    unsafe["$cur"]=1
    cur="$(lsblk -n -o PKNAME "/dev/${cur}" 2>/dev/null | head -n 1 || true)"
    cur="${cur#/dev/}"
  done
}

# Resolve a live-media source (device, file, loop backing file or /proc/cmdline token)
# to the underlying whole disk and mark it unsafe.
disk_unsafe_from_source() {
  local src="$1" depth="${2:-0}" backing mount_source target resolved
  ((depth < 8)) || return 0
  [[ -n $src ]] || return 0

  case "$src" in
    UUID=*|LABEL=*|PARTUUID=*|PARTLABEL=*)
      resolved="$(blkid -o device -t "$src" 2>/dev/null | head -n 1 || true)"
      [[ -n $resolved ]] && disk_unsafe_from_source "$resolved" "$((depth + 1))"
      return 0
      ;;
  esac

  if [[ $src == /dev/loop* ]]; then
    disk_mark_tree_unsafe "$src"
    backing="$(losetup -n -o BACK-FILE "$src" 2>/dev/null | head -n 1 || true)"
    [[ -n $backing ]] && disk_unsafe_from_source "$backing" "$((depth + 1))"
    return 0
  fi
  if [[ $src == /dev/* ]]; then
    disk_mark_tree_unsafe "$src"
    return 0
  fi
  if [[ -e $src ]]; then
    target="$src"
    [[ -d $target ]] || target="$(dirname "$target")"
    mount_source="$(findmnt -n -o SOURCE --target "$target" 2>/dev/null | head -n 1 || true)"
    if [[ -n $mount_source && $mount_source != "$src" ]]; then
      disk_unsafe_from_source "$mount_source" "$((depth + 1))"
    fi
  fi
}

disk_enumerate() {
  DISK_PATHS=(); DISK_BYTES=(); DISK_HUMAN=(); DISK_MODEL=()
  local -A bytes_map=() human_map=() model_map=() unsafe=()
  local name bytes type human model target source loop backing cmdline token

  # Never offer a disk that is already in use by the running live system. This
  # includes mounted partitions, loop-backed live media and their parent disks.
  while read -r name; do
    [[ -n ${name:-} ]] || continue
    disk_mark_tree_unsafe "$name"
  done < <(lsblk -n -o NAME,MOUNTPOINT -e rom 2>/dev/null | while read -r n m; do
    [[ -n ${m:-} ]] && printf '%s\n' "$n"
  done || true)

  # Live media mount points (ISO, USB stick, PXE findiso and Ventoy all differ).
  for target in /run/live/medium /cdrom /live; do
    source="$(findmnt -n -o SOURCE --target "$target" 2>/dev/null | head -n 1 || true)"
    disk_unsafe_from_source "$source"
  done

  # A Ventoy/loop-mounted ISO often has no mounted partition on the USB disk itself.
  # Follow every loop device back to its backing file and then to the parent disk.
  while read -r loop backing; do
    [[ -n ${loop:-} ]] || continue
    unsafe["${loop#/dev/}"]=1
    [[ -n ${backing:-} ]] && disk_unsafe_from_source "$backing"
  done < <(losetup -n -o NAME,BACK-FILE 2>/dev/null || true)

  cmdline="$(tr '\n' ' ' </proc/cmdline 2>/dev/null || true)"
  for token in $cmdline; do
    case "$token" in
      live-media=*) disk_unsafe_from_source "${token#live-media=}" ;;
      findiso=*|iso-scan/filename=*) disk_unsafe_from_source "${token#*=}" ;;
    esac
  done

  while read -r name bytes type; do
    [[ -n ${name:-} && ${type:-} == disk ]] || continue
    [[ -n ${unsafe[$name]:-} ]] && continue
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

disk_count_role() {
  local wanted="$1" row dev role wipe count=0
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role wipe <<< "$row"
    [[ $role == "$wanted" ]] && count=$((count + 1))
  done
  printf '%d\n' "$count"
}

# Config-level geometry checks must run before any sgdisk --zap-all call.
disk_check_raid_members() {
  local label="$1" count="$2" required
  case "$CFG_RAID" in
    single)
      ((count == 1)) || die "raid=single requires exactly one ${label} disk, got ${count}"
      ;;
    mirror)
      ((count >= 2)) || die "raid=mirror needs at least 2 ${label} disks, got ${count}"
      ;;
    raidz1)
      ((count >= 3)) || die "raid=raidz1 needs at least 3 ${label} disks, got ${count}"
      ;;
    raidz2)
      ((count >= 4)) || die "raid=raidz2 needs at least 4 ${label} disks, got ${count}"
      ;;
    raidz10)
      ((count >= 4)) || die "raid=raidz10 needs at least 4 ${label} disks, got ${count}"
      ((count % 2 == 0)) || die "raid=raidz10 needs an even number of ${label} disks, got ${count}"
      ;;
    *) die "unsupported raid level: ${CFG_RAID}" ;;
  esac
}

disk_print_table() {
  printf '  %-4s %-26s %-10s %s\n' '#' 'DEVICE' 'SIZE' 'MODEL'
  local i
  for i in "${!DISK_PATHS[@]}"; do
    printf '  %-4s %-26s %-10s %s\n' "$((i + 1))" "${DISK_PATHS[i]}" "${DISK_HUMAN[i]}" "${DISK_MODEL[i]}"
  done
}

disk_resolve_name() {
  local dev="$1" resolved=""
  resolved="$(readlink -f -- "$dev" 2>/dev/null || printf '%s' "$dev")"
  printf '%s' "${resolved#/dev/}"
}

disk_is_safe() {
  local dev="$1" resolved name
  resolved="$(disk_resolve_name "$dev")"
  for name in "${DISK_PATHS[@]}"; do
    [[ $(disk_resolve_name "$name") == "$resolved" ]] && return 0
  done
  return 1
}

disk_validate_configured() {
  local row dev role wipe type size resolved
  local system_count data_count parity_count storage_count cache_count
  disk_enumerate
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role wipe <<< "$row"
    [[ -n $dev ]] || die "empty disk path in configuration"
    [[ -b $dev ]] || die "configured disk does not exist or is not a block device: ${dev}"
    type="$(lsblk -d -n -o TYPE "$dev" 2>/dev/null || true)"
    [[ $type == disk ]] || die "configured path is not a whole disk: ${dev}"
    disk_is_safe "$dev" || die "configured disk is in use by the live system or was not detected: ${dev}"
    [[ ${wipe:-true} == true ]] || die "${dev} has wipe:false; the installer can only install on disks it may erase"
    case "$role" in
      system|data|parity|cache) ;;
      *) die "unknown disk role '${role}' for ${dev}" ;;
    esac
    if [[ $role == system ]]; then
      size="$(lsblk -b -d -n -o SIZE "$dev" 2>/dev/null || echo 0)"
      ((size >= 34359738368)) || die "system disk ${dev} is smaller than 32 GiB"
    fi
    resolved="$(disk_resolve_name "$dev")"
    log_info "Validated ${role} disk ${dev} (${resolved})"
  done

  system_count="$(disk_count_role system)"
  data_count="$(disk_count_role data)"
  parity_count="$(disk_count_role parity)"
  cache_count="$(disk_count_role cache)"
  storage_count=$((data_count + parity_count))

  ((system_count > 0)) || die "at least one disk with role=system is required"

  case "$CFG_FS" in
    btrfs)
      [[ $CFG_RAID == single || $CFG_RAID == mirror ]] || \
        die "btrfs root supports raid=single or raid=mirror only (got ${CFG_RAID})"
      ;;
    zfs|ext4) ;;
    *) die "unsupported filesystem: ${CFG_FS}" ;;
  esac
  disk_check_raid_members "system" "$system_count"

  if ((storage_count > 0)); then
    case "$CFG_FS" in
      btrfs)
        ((parity_count == 0)) || die "btrfs parity roles are not supported; use ZFS or ext4 with mdadm"
        case "$CFG_RAID" in
          single|mirror|raidz10) ;;
          *) die "btrfs storage supports raid=single, mirror or raidz10 only (got ${CFG_RAID})" ;;
        esac
        disk_check_raid_members "storage" "$storage_count"
        ;;
      zfs|ext4)
        if ((parity_count > 0)); then
          case "$CFG_RAID" in
            raidz1) ((parity_count == 1)) || die "raidz1 supports exactly one parity disk, got ${parity_count}" ;;
            raidz2) ((parity_count == 2)) || die "raidz2 supports exactly two parity disks, got ${parity_count}" ;;
            *) die "parity disks require raid=raidz1 or raidz2 (got ${CFG_RAID})" ;;
          esac
        fi
        disk_check_raid_members "storage" "$storage_count"
        ;;
    esac
  elif ((cache_count > 0)); then
    log_warn "cache disks without data disks are ignored"
  fi

  log_info "Layout validated: fs=${CFG_FS}, raid=${CFG_RAID}, system=${system_count}, storage=${storage_count}, parity=${parity_count}, cache=${cache_count}"
}

# Standard path: smallest unused disk >= 32 GiB is the system disk; every remaining
# unused disk becomes a data disk. Two or more data disks default to a ZFS mirror.
disk_select_standard() {
  disk_enumerate
  ((${#DISK_PATHS[@]} > 0)) || die "no unused disks found (check 'lsblk -d')"

  local i sys_idx=-1
  for i in "${!DISK_PATHS[@]}"; do
    if (( DISK_BYTES[i] >= 34359738368 )); then sys_idx=$i; break; fi
  done
  ((sys_idx >= 0)) || die "no unused disk with at least 32 GiB found"

  DISK_ROWS=()
  DISK_ROWS+=("$(printf '%s\tsystem\ttrue' "${DISK_PATHS[sys_idx]}")")
  local data_count=0
  for i in "${!DISK_PATHS[@]}"; do
    [[ $i -eq $sys_idx ]] && continue
    DISK_ROWS+=("$(printf '%s\tdata\ttrue' "${DISK_PATHS[i]}")")
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

raid_required_disks() {
  case "$1" in
    single) printf '1\n' ;;
    mirror) printf '2\n' ;;
    raidz1) printf '3\n' ;;
    raidz2|raidz10) printf '4\n' ;;
    *) printf '1\n' ;;
  esac
}

# zfs uses one parity device for raidz1 and two for raidz2. mirror has no parity.
zfs_spec() {
  local level="$1"; shift
  local -a parts=("$@") spec=()
  local i=0
  case "$level" in
    single)
      ((${#parts[@]} == 1)) || die "raid=single requires exactly one device, got ${#parts[@]}"
      spec=("${parts[@]}")
      ;;
    mirror)
      ((${#parts[@]} >= 2)) || die "raid=mirror needs at least 2 disks, got ${#parts[@]}"
      spec=(mirror "${parts[@]}") ;;
    raidz1)
      ((${#parts[@]} >= 3)) || die "raid=raidz1 needs at least 3 disks, got ${#parts[@]}"
      spec=(raidz1 "${parts[@]}") ;;
    raidz2)
      ((${#parts[@]} >= 4)) || die "raid=raidz2 needs at least 4 disks, got ${#parts[@]}"
      spec=(raidz2 "${parts[@]}") ;;
    raidz10)
      ((${#parts[@]} >= 4)) || die "raid=raidz10 needs at least 4 disks, got ${#parts[@]}"
      (( ${#parts[@]} % 2 == 0 )) || die "raid=raidz10 needs an even number of disks, got ${#parts[@]}"
      while ((i + 1 < ${#parts[@]})); do
        spec+=(mirror "${parts[i]}" "${parts[i + 1]}")
        i=$((i + 2))
      done
      ;;
    *) die "unsupported raid level: ${level}" ;;
  esac
  printf '%s\0' "${spec[@]}"
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

  local efi
  for efi in "${SYSTEM_EFI_PARTS[@]}"; do
    run mkfs.vfat -F32 -n WREXR_EFI "$efi"
  done
}

# Append a stable fstab entry (resolved by UUID when the device exists).
fstab_add() {
  local dev="$1" mnt="$2" fstype="$3" opts="$4" pass="$5" uuid="" source="$dev"
  if ((!DRY_RUN)); then
    uuid="$(blkid -s UUID -o value "$dev" 2>/dev/null || true)"
    [[ -n $uuid ]] && source="UUID=$uuid"
  fi
  local line="${source}  ${mnt}  ${fstype}  ${opts}  0 ${pass}"
  if ((DRY_RUN)); then printf '  [dry-run] fstab: %s\n' "$line" >&2; fi
  FSTAB_ENTRIES+=("$line")
}

fstab_write() {
  local content
  content="$(printf '%s\n' \
    '# /etc/fstab generated by wrexr-installer.sh' \
    '# <file system>  <mount point>  <type>  <options>  <dump>  <pass>' \
    "${FSTAB_ENTRIES[@]}")"
  write_file "$TARGET/etc/fstab" "$content" 644
}

# DESTRUCTIVE: create the root filesystem (or pool) and mount it at $TARGET.
disk_create_root_fs() {
  log_info "Creating root filesystem: ${CFG_FS}, raid=${CFG_RAID}"
  FSTAB_ENTRIES=()
  run mkdir -p "$TARGET"
  local root_dev="${SYSTEM_ROOT_PARTS[0]}"
  local -a spec=()
  local i tmp_mount

  case "$CFG_FS" in
    zfs)
      mapfile -d '' -t spec < <(zfs_spec "$CFG_RAID" "${SYSTEM_ROOT_PARTS[@]}")
      run zpool create -f -o "altroot=$TARGET" -O mountpoint=/ \
        -O compression=lz4 -O atime=off -O xattr=sa \
        -o cachefile=/etc/zfs/zpool.cache rpool "${spec[@]}"
      run zpool set bootfs=rpool rpool
      ;;
    btrfs)
      [[ $CFG_RAID == single || $CFG_RAID == mirror ]] || \
        die "btrfs root supports raid=single or raid=mirror only (got ${CFG_RAID})"
      if [[ $CFG_RAID == single ]]; then
        ((${#SYSTEM_ROOT_PARTS[@]} == 1)) || die "raid=single requires exactly one system disk"
      fi
      local -a mkfs=(mkfs.btrfs -f -L WREXR_ROOT)
      if ((${#SYSTEM_ROOT_PARTS[@]} > 1)); then
        [[ $CFG_RAID == mirror ]] || die "btrfs mirror requires raid=mirror"
        mkfs+=(-d raid1 -m raid1)
      fi
      run "${mkfs[@]}" "${SYSTEM_ROOT_PARTS[@]}"
      tmp_mount="$(mktemp -d /tmp/wrexr-btrfs.XXXXXX)"
      run mount -o compress=lz4 "$root_dev" "$tmp_mount"
      run btrfs subvolume create "${tmp_mount}/@"
      run btrfs subvolume create "${tmp_mount}/@home"
      run umount "$tmp_mount"
      run rmdir "$tmp_mount"
      run mount -o subvol=@,compress=lz4 "$root_dev" "$TARGET"
      run mkdir -p "$TARGET/home"
      run mount -o subvol=@home,compress=lz4 "$root_dev" "$TARGET/home"
      fstab_add "$root_dev" / btrfs 'subvol=@,compress=lz4' 1
      fstab_add "$root_dev" /home btrfs 'subvol=@home,compress=lz4' 2
      ;;
    ext4)
      local mdlevel=""
      case "$CFG_RAID" in
        single)
          ((${#SYSTEM_ROOT_PARTS[@]} == 1)) || die "raid=single requires exactly one system disk"
          ;;
        mirror) mdlevel=1 ;;
        raidz1) mdlevel=5 ;;
        raidz2) mdlevel=6 ;;
        raidz10) mdlevel=10 ;;
        *) die "unsupported raid level: ${CFG_RAID}" ;;
      esac
      if [[ -n $mdlevel ]]; then
        local required required_num count=${#SYSTEM_ROOT_PARTS[@]}
        required="$(raid_required_disks "$CFG_RAID")"
        required_num=$required
        ((count >= required_num)) || die "raid=${CFG_RAID} needs at least ${required_num} system disks, got ${count}"
        if [[ $CFG_RAID == raidz10 ]]; then
          ((count % 2 == 0)) || die "raid=raidz10 needs an even number of system disks, got ${count}"
        fi
        run mdadm --create /dev/md/wrexr-root --level="$mdlevel" --raid-devices="$count" \
          --name=wrexr-root "${SYSTEM_ROOT_PARTS[@]}"
        root_dev=/dev/md/wrexr-root
      fi
      run mkfs.ext4 -F -L WREXR_ROOT "$root_dev"
      run mount "$root_dev" "$TARGET"
      fstab_add "$root_dev" / ext4 defaults 1
      ;;
    *) die "unsupported filesystem: $CFG_FS" ;;
  esac

  run mkdir -p "$TARGET/boot/efi"
  run mount "${SYSTEM_EFI_PARTS[0]}" "$TARGET/boot/efi"
  fstab_add "${SYSTEM_EFI_PARTS[0]}" /boot/efi vfat 'umask=0077' 2

  local swap idx=0
  for swap in "${SYSTEM_SWAP_PARTS[@]}"; do
    run mkswap -L "WREXRSWAP${idx}" "$swap"
    fstab_add "$swap" none swap sw 0
    idx=$((idx + 1))
  done
}

mdadm_register_arrays() {
  local conf="$TARGET/etc/mdadm/mdadm.conf"
  [[ -d $TARGET/etc/mdadm ]] || return 0
  {
    printf '# Generated by wrexr-installer.sh\n'
    mdadm --detail --scan 2>/dev/null || true
  } >> "$conf"
}

# DESTRUCTIVE: wipe data/parity/cache members and build the storage pool.
disk_prepare_storage() {
  DATA_PARTS=(); PARITY_PARTS=(); STORAGE_PARTS=(); CACHE_PARTS=()
  local row dev role wipe part
  for row in "${DISK_ROWS[@]}"; do
    IFS=$'\t' read -r dev role wipe <<< "$row"
    case "$role" in
      data|parity)
        log_info "DESTRUCTIVE: wiping ${role} disk ${dev} for the storage pool"
        run sgdisk --zap-all "$dev"
        run sgdisk --clear "$dev"
        run sgdisk --new=1:0:0 --typecode=1:BF00 "--change-name=1:Wrexr ${role^}" "$dev"
        run partprobe "$dev" || true
        part="$(part_path "$dev" 1)"
        if [[ $role == parity ]]; then PARITY_PARTS+=("$part"); else DATA_PARTS+=("$part"); fi
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

  ((${#STORAGE_PARTS[@]} > 0)) || {
    ((${#CACHE_PARTS[@]} > 0)) && log_warn "cache disks without data disks are ignored"
    return 0
  }

  local n=${#STORAGE_PARTS[@]} parity=${#PARITY_PARTS[@]} required=0
  local -a spec=()
  case "$CFG_FS" in
    btrfs)
      ((parity == 0)) || die "btrfs parity roles are not supported; use ZFS or ext4 with mdadm"
      case "$CFG_RAID" in
        single) required=1 ;;
        mirror) required=2 ;;
        raidz10) required=4 ;;
        *) die "btrfs supports raid=single, mirror or raidz10 only (got ${CFG_RAID})" ;;
      esac
      ((n >= required)) || die "raid=${CFG_RAID} needs at least ${required} storage disks, got ${n}"
      if [[ $CFG_RAID == single ]]; then
        ((n == 1)) || die "raid=single requires exactly one storage disk, got ${n}"
      fi
      if [[ $CFG_RAID == raidz10 ]]; then
        ((n % 2 == 0)) || die "raid=raidz10 needs an even number of storage disks, got ${n}"
      fi
      ;;
    *)
      required="$(raid_required_disks "$CFG_RAID")"
      ((n >= required)) || die "raid=${CFG_RAID} needs at least ${required} storage disks, got ${n}"
      if [[ $CFG_RAID == raidz10 ]]; then
        ((n % 2 == 0)) || die "raid=raidz10 needs an even number of storage disks, got ${n}"
      fi
      if ((parity > 0)); then
        case "$CFG_RAID" in
          raidz1) ((parity == 1)) || die "raidz1 supports exactly one parity disk, got ${parity}" ;;
          raidz2) ((parity == 2)) || die "raidz2 supports exactly two parity disks, got ${parity}" ;;
          *) die "parity disks require raid=raidz1 or raidz2 (got ${CFG_RAID})" ;;
        esac
      fi
      ;;
  esac

  case "$CFG_FS" in
    zfs)
      mapfile -d '' -t spec < <(zfs_spec "$CFG_RAID" "${STORAGE_PARTS[@]}")
      run zpool create -f -o "altroot=$TARGET" -O mountpoint=/mnt/wrexr \
        -O compression=zstd -O atime=off -O xattr=sa tank "${spec[@]}"
      local cache
      for cache in "${CACHE_PARTS[@]}"; do
        log_info "Adding L2ARC cache device ${cache} to tank"
        run zpool add -f tank cache "$cache"
      done
      run mkdir -p "$TARGET/mnt/wrexr"
      ;;
    btrfs)
      local profile="single"
      case "$CFG_RAID" in
        mirror) profile="raid1" ;;
        raidz10) profile="raid10" ;;
      esac
      local -a args=(-f -L WREXR_DATA)
      [[ $profile == single ]] || args+=(-d "$profile" -m "$profile")
      run mkfs.btrfs "${args[@]}" "${STORAGE_PARTS[@]}"
      run mkdir -p "$TARGET/mnt/wrexr"
      run mount -o compress=zstd "${STORAGE_PARTS[0]}" "$TARGET/mnt/wrexr"
      fstab_add "${STORAGE_PARTS[0]}" /mnt/wrexr btrfs compress=zstd 2
      if ((${#CACHE_PARTS[@]} > 0)); then log_warn "btrfs does not use ZFS cache devices; cache disks are left unused"; fi
      ;;
    ext4)
      local data_dev="${STORAGE_PARTS[0]}" mdlevel=""
      case "$CFG_RAID" in
        single) ((${#STORAGE_PARTS[@]} == 1)) || die "raid=single requires exactly one storage disk" ;;
        mirror) mdlevel=1 ;;
        raidz1) mdlevel=5 ;;
        raidz2) mdlevel=6 ;;
        raidz10) mdlevel=10 ;;
      esac
      if [[ -n $mdlevel ]]; then
        run mdadm --create /dev/md/wrexr-data --level="$mdlevel" --raid-devices="$n" \
          --name=wrexr-data "${STORAGE_PARTS[@]}"
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

# Release all mounts, pools and md arrays (safe to call twice).
disk_release_resources() {
  if ((TARGET_API_MOUNTED)); then
    run umount "$TARGET/run" 2>/dev/null || true
    run umount "$TARGET/proc" 2>/dev/null || true
    run umount "$TARGET/sys" 2>/dev/null || true
    run umount "$TARGET/dev" 2>/dev/null || true
    TARGET_API_MOUNTED=0
  fi
  run umount -R "$TARGET/boot/efi" 2>/dev/null || true
  run umount -R "$TARGET/home" 2>/dev/null || true
  run umount -R "$TARGET" 2>/dev/null || true
  if [[ $CFG_FS == zfs ]]; then
    run zpool export tank 2>/dev/null || true
    run zpool export rpool 2>/dev/null || true
  fi
  run mdadm --stop /dev/md/wrexr-data 2>/dev/null || true
  run mdadm --stop /dev/md/wrexr-root 2>/dev/null || true
}

disk_unmount_all() {
  log_info "Unmounting target and exporting pools"
  disk_release_resources
}
