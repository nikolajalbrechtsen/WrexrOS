# base.sh - Debian base system, WrexrOS packages, chroot configuration.
# Sourced by wrexr-installer.sh. Uses the framework functions from the main script.

base_debootstrap() {
  local includes="ca-certificates,apt,systemd-sysv,iproute2,iputils-ping,kmod,udev,openssh-server,nftables,chrony,curl,wget,sudo,jq,openssl,vim-tiny,rsync,procps,less,linux-image-amd64,initramfs-tools,grub-common,grub2-common,os-prober,grub-pc-bin,grub-efi-amd64-bin,efibootmgr,ifupdown,bridge-utils,isc-dhcp-client,resolvconf,dosfstools,tzdata,console-setup,e2fsprogs,mdadm,xz-utils"
  case "$CFG_FS" in
    zfs) includes+=",zfsutils-linux,zfs-initramfs" ;;
    btrfs) includes+=",btrfs-progs" ;;
  esac
  log_info "Running debootstrap bookworm (components: main,contrib,non-free)"
  run env DEBIAN_FRONTEND=noninteractive debootstrap \
    --arch=amd64 \
    --components=main,contrib,non-free,non-free-firmware \
    --include="$includes" \
    bookworm "$TARGET" "${DEBIAN_MIRROR:-http://deb.debian.org/debian}"
}

mount_target_api_fs() {
  ((TARGET_API_MOUNTED)) && return 0
  log_info "Mounting /dev, /proc, /sys and /run in the target chroot"
  run mkdir -p "$TARGET/dev" "$TARGET/proc" "$TARGET/sys" "$TARGET/run"
  run mount --rbind /dev "$TARGET/dev"
  run mount --make-rslave "$TARGET/dev" 2>/dev/null || true
  run mount -t proc proc "$TARGET/proc"
  run mount -t sysfs sysfs "$TARGET/sys"
  run mount --rbind /run "$TARGET/run"
  run mount --make-rslave "$TARGET/run" 2>/dev/null || true
  TARGET_API_MOUNTED=1
}

install_node_runtime_target() {
  local version="24.22.3"
  local archive="${SCRIPT_DIR}/../runtime/node-v${version}-linux-x64.tar.xz"
  [[ -f $archive ]] || archive="${TARGET}/opt/wrexr/runtime/node-v${version}-linux-x64.tar.xz"
  [[ -f $archive ]] || die "Node.js runtime archive is missing from the installation media: ${archive}"
  log_info "Installing Node.js ${version} runtime in the target system"
  run mkdir -p "$TARGET/opt/wrexr-node" "$TARGET/usr/local/bin"
  if ((!DRY_RUN)); then
    rm -rf -- "$TARGET/opt/wrexr-node"
    mkdir -p "$TARGET/opt/wrexr-node"
  fi
  run tar -xJf "$archive" -C "$TARGET/opt/wrexr-node" --strip-components=1
  local bin
  for bin in node npm npx corepack; do
    run ln -sfn "/opt/wrexr-node/bin/${bin}" "${TARGET}/usr/local/bin/${bin}"
  done
}

base_copy_packages() {
  local src="$CFG_PKG_SRC" alt deb count=0
  for alt in /cdrom/wrexr/packages /run/wrexr/packages /opt/wrexr/packages "${SCRIPT_DIR}/../packages"; do
    [[ -d $src ]] && break
    [[ -d $alt ]] && src="$alt"
  done
  if [[ ! -d $src ]]; then
    log_warn "package source '$CFG_PKG_SRC' not found; leaving base Debian packages only"
    return 0
  fi
  log_info "Copying WrexrOS packages from ${src}"
  run mkdir -p "$TARGET/opt/wrexr/packages"
  shopt -s nullglob
  for deb in "$src"/*.deb; do
    run cp -f -- "$deb" "$TARGET/opt/wrexr/packages/"
    count=$((count + 1))
  done
  shopt -u nullglob
  if ((count > 0)); then
    # Static chroot script: no user input is interpolated into the shell string.
    run env DEBIAN_FRONTEND=noninteractive chroot "$TARGET" /bin/bash -c \
      'cd /opt/wrexr/packages && dpkg -i ./*.deb || apt-get -f install -y'
  else
    log_warn "no .deb files in ${src}; skipping local package installation"
  fi
}

base_copy_repo() {
  local repo_src="${WREXR_REPO_SRC:-${SCRIPT_DIR}/..}"
  if [[ -f /opt/wrexr/installer/wrexr-installer.sh ]]; then repo_src=/opt/wrexr; fi
  log_info "Copying WrexrOS runtime files from ${repo_src} to /opt/wrexr"
  if ((DRY_RUN)); then
    printf '  [dry-run] cp -a %q/. %q/opt/wrexr/\n' "$repo_src" "$TARGET"
    return 0
  fi
  run mkdir -p "$TARGET/opt/wrexr"
  run cp -a "$repo_src/." "$TARGET/opt/wrexr/"
}

write_state_json() {
  local disks rows shares users dns
  disks="$(printf '%s\n' "${DISK_ROWS[@]}")"
  rows="$(printf '%s\n' "${NET_DNS[@]}")"
  dns="$rows"
  shares="$(printf '%s\n' "${SHARE_ROWS[@]}")"
  users="$(printf '%s\n' "${USER_ROWS[@]}")"

  local json
  json="$(WREXR_STATE_VERSION="$WREXR_VERSION" \
    WREXR_MODE="$WREXR_MODE" \
    WREXR_STATE_HOST="$CFG_HOSTNAME" \
    WREXR_STATE_TZ="$CFG_TIMEZONE" \
    WREXR_STATE_KBD="$CFG_KEYBOARD" \
    WREXR_STATE_FS="$CFG_FS" \
    WREXR_STATE_RAID="$CFG_RAID" \
    WREXR_STATE_DISKS="$disks" \
    WREXR_NET_MODE="$NET_MODE" \
    WREXR_NET_IFACE="$NET_IFACE" \
    WREXR_NET_BRIDGE="$NET_BRIDGE" \
    WREXR_NET_ADDR="$NET_ADDRESS" \
    WREXR_NET_MASK="$NET_NETMASK" \
    WREXR_NET_GW="$NET_GATEWAY" \
    WREXR_NET_DNS="$dns" \
    WREXR_STATE_PORT="$CFG_UI_PORT" \
    WREXR_STATE_CHANNEL="$CFG_CHANNEL" \
    WREXR_STATE_SHARES="$shares" \
    WREXR_STATE_USERS="$users" node -e '
const e = process.env;
const lines = (v) => (v || "").split("\n").filter(Boolean);
const pairs = (v) => lines(v).map((line) => {
  const fields = line.split("\t");
  return { name: fields[0], role: fields[1], protocol: fields[1], path: fields[2], readOnly: fields[3] === "true", recycle: fields[4] === "true", users: (fields[5] || "").split("|").filter(Boolean) };
});
const o = {
  schemaVersion: 1,
  product: "WrexrOS",
  version: e.WREXR_STATE_VERSION,
  installedAt: new Date().toISOString(),
  installMode: e.WREXR_MODE,
  hostname: e.WREXR_STATE_HOST,
  timezone: e.WREXR_STATE_TZ,
  keyboardLayout: e.WREXR_STATE_KBD,
  filesystem: e.WREXR_STATE_FS,
  raid: e.WREXR_STATE_RAID,
  disks: lines(e.WREXR_STATE_DISKS).map((line) => {
    const [path, role] = line.split("\t");
    return { path, role };
  }),
  network: {
    mode: e.WREXR_NET_MODE,
    interface: e.WREXR_NET_IFACE,
    bridge: e.WREXR_NET_BRIDGE,
    address: e.WREXR_NET_ADDR || null,
    netmask: e.WREXR_NET_MASK || null,
    gateway: e.WREXR_NET_GW || null,
    dns: lines(e.WREXR_NET_DNS)
  },
  uiPort: Number(e.WREXR_STATE_PORT),
  updateChannel: e.WREXR_STATE_CHANNEL,
  users: lines(e.WREXR_STATE_USERS).map((line) => {
    const [name, groups, shell] = line.split("\t");
    return { name, groups: (groups || "").split("|").filter(Boolean), shell: shell || "/bin/bash" };
  }),
  shares: lines(e.WREXR_STATE_SHARES).map((line) => {
    const r = pairs(line);
    return { name: r.name, protocol: r.protocol, path: r.path, readOnly: r.readOnly, recycle: r.recycle, users: r.users };
  })
};
process.stdout.write(JSON.stringify(o, null, 2));
')"
  write_file "$TARGET/etc/wrexr/install-state.json" "$json" 600
}

write_daemon_toml() {
  local toml
  toml="$(printf '%s\n' \
    '# Generated by wrexr-installer.sh; managed via /api/v1/settings/raw' \
    '' \
    "port = ${CFG_UI_PORT}" \
    'tls = true' \
    'tlsCert = "/var/lib/wrexr/tls/cert.pem"' \
    'tlsKey = "/var/lib/wrexr/tls/key.pem"' \
    'basePath = "/api/v1"' \
    'stateDir = "/var/lib/wrexr"' \
    "demoMode = ${CFG_DEMO}" \
    "updateChannel = \"${CFG_CHANNEL}\"" \
    "repoUrl = \"${CFG_REPO_URL}\"" \
    '' \
    '[log]' \
    'level = "info"')"
  write_file "$TARGET/etc/wrexr/wrexrd.toml" "$toml" 600
  write_file "$TARGET/etc/wrexr/version" "$WREXR_VERSION" 644
}

set_root_password() {
  if [[ -z $AUTH_PASSWORD ]]; then
    log_info "No root password configured; SSH key authentication only"
    return 0
  fi
  [[ $AUTH_PASSWORD != *:* && $AUTH_PASSWORD != *$'\n'* ]] || die "root password contains an invalid character"
  if ((DRY_RUN)); then
    printf '  [dry-run] printf "root:<redacted>\\n" | chroot %q chpasswd\n' "$TARGET"
    return 0
  fi
  printf 'root:%s\n' "$AUTH_PASSWORD" | chroot "$TARGET" chpasswd || die "failed to set root password"
  log_info "Root password set (value redacted)"
}

install_ssh_keys() {
  if ((${#AUTH_SSH_KEYS[@]} == 0)); then return 0; fi
  log_info "Installing ${#AUTH_SSH_KEYS[@]} authorized key(s) for root"
  write_file "$TARGET/root/.ssh/authorized_keys" "$(printf '%s\n' "${AUTH_SSH_KEYS[@]}")" 600
  run chown -R root:root "$TARGET/root/.ssh"
}

configure_users() {
  local row name groups shell keys password key_content
  for row in "${USER_ROWS[@]}"; do
    IFS=$'\t' read -r name groups shell keys password <<< "$row"
    [[ -n $name ]] || continue
    log_info "Creating local user ${name}"
    chroot_script "create user ${name}" \
      "WREXR_USER=${name}" \
      "WREXR_GROUPS=${groups//|/,}" \
      "WREXR_SHELL=${shell:-/bin/bash}" \
      "WREXR_PASSWORD=${password}" <<'EOS'
set -e
if ! id -u "$WREXR_USER" >/dev/null 2>&1; then
  useradd -m -s "$WREXR_SHELL" "$WREXR_USER"
fi
if [ -n "$WREXR_GROUPS" ]; then
  usermod -aG "$WREXR_GROUPS" "$WREXR_USER"
fi
if [ -n "$WREXR_PASSWORD" ]; then
  printf '%s:%s\n' "$WREXR_USER" "$WREXR_PASSWORD" | chpasswd
fi
install -d -m 0700 -o "$WREXR_USER" -g "$WREXR_USER" "/home/$WREXR_USER/.ssh"
EOS
    if [[ -n $keys ]]; then
      key_content="${keys//|/$'\n'}"
      write_file "$TARGET/home/${name}/.ssh/authorized_keys" "$key_content" 600
      run chown -R "${name}:${name}" "$TARGET/home/${name}/.ssh"
    fi
  done
}

create_service_account() {
  chroot_script "create wrexr service account" <<'EOS'
set -e
if ! id -u wrexr >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/wrexr --shell /usr/sbin/nologin wrexr
fi
for group in kvm libvirt docker; do
  if ! getent group "$group" >/dev/null 2>&1; then
    groupadd "$group"
  fi
  usermod -aG "$group" wrexr
done
install -d -o wrexr -g wrexr -m 0750 /var/lib/wrexr /run/wrexr /var/log/wrexr
install -d -o wrexr -g wrexr -m 0700 /var/lib/wrexr/tls
EOS
}

base_install_units() {
  local src="${SCRIPT_DIR}/../systemd" unit
  log_info "Installing WrexrOS systemd units and sudoers policy"
  for unit in wrexrd.service wrexr-console.service wrexr-updater.service wrexr-updater.timer wrexr-kiosk.service; do
    run install -m 0644 "${src}/${unit}" "$TARGET/etc/systemd/system/${unit}"
  done
  run install -m 0644 "${SCRIPT_DIR}/../boot/wrexr-banner.service" \
    "$TARGET/etc/systemd/system/wrexr-banner.service"
  run install -m 0644 \
    "${SCRIPT_DIR}/../packaging/live-build/includes.chroot/usr/lib/systemd/system/wrexr-firstboot.service" \
    "$TARGET/etc/systemd/system/wrexr-firstboot.service"
  run install -m 0440 "${src}/00-wrexr.conf" "$TARGET/etc/sudoers.d/00-wrexr.conf"
  run install -m 0644 "${SCRIPT_DIR}/../boot/issue" "$TARGET/etc/issue"
}

enable_services() {
  local svc
  local -a services=(wrexrd wrexr-console wrexr-updater.timer wrexr-firstboot.service chrony)
  [[ $FW_ENABLED == true ]] && services+=(nftables)
  [[ $CFG_FS == zfs ]] && services+=(zfs-mount.service zfs-share.service)
  for svc in "${services[@]}"; do
    if ((DRY_RUN)); then
      printf '  [dry-run] chroot %q systemctl enable %q\n' "$TARGET" "$svc"
      continue
    fi
    if ! chroot "$TARGET" systemctl enable "$svc" >/dev/null 2>&1; then
      log_warn "could not enable ${svc} (unit may not be installed yet)"
    fi
  done
}

base_configure() {
  log_info "Configuring chroot: hostname, users, credentials, services"
  run mkdir -p "$TARGET/etc/wrexr" "$TARGET/var/lib/wrexr" "$TARGET/run/wrexr" "$TARGET/var/log/wrexr" "$TARGET/etc/sudoers.d"

  create_service_account
  base_install_units

  # Fresh install: the first-boot wizard must run even if the ISO carried a marker.
  run rm -f "$TARGET/var/lib/wrexr/setup-complete"

  if [[ $CFG_FS == zfs && -f /etc/zfs/zpool.cache ]]; then
    run cp -f /etc/zfs/zpool.cache "$TARGET/etc/zfs/zpool.cache"
  fi

  write_state_json
  write_daemon_toml
  set_root_password
  install_ssh_keys
  configure_users

  [[ -e /usr/share/zoneinfo/${CFG_TIMEZONE} ]] || die "unknown timezone: ${CFG_TIMEZONE}"
  run ln -sfn "/usr/share/zoneinfo/${CFG_TIMEZONE}" "$TARGET/etc/localtime"
  write_file "$TARGET/etc/timezone" "$CFG_TIMEZONE" 644
  write_file "$TARGET/etc/default/keyboard" "$(printf '%s\n' \
    "XKBLAYOUT=\"${CFG_KEYBOARD}\"" \
    'BACKSPACE="guess"')" 644
  write_file "$TARGET/etc/default/locale" 'LANG=C.UTF-8' 644

  local ssh_password_auth="no" permit_root="prohibit-password"
  if [[ -z $AUTH_PASSWORD ]]; then
    ((${#AUTH_SSH_KEYS[@]} > 0)) || die "auth requires a root password or at least one SSH key"
  else
    ssh_password_auth="yes"
    ((${#AUTH_SSH_KEYS[@]} > 0)) || permit_root="yes"
  fi
  write_file "$TARGET/etc/ssh/sshd_config.d/10-wrexr.conf" "$(printf '%s\n' \
    '# Managed by wrexr-installer.sh' \
    "PermitRootLogin ${permit_root}" \
    "PasswordAuthentication ${ssh_password_auth}" \
    'X11Forwarding no')" 644

  chroot_script "final system configuration" \
    "WREXR_TIMEZONE=${CFG_TIMEZONE}" \
    "WREXR_KEYBOARD=${CFG_KEYBOARD}" <<'EOS'
set -e
if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates >/dev/null; fi
if command -v depmod >/dev/null 2>&1; then depmod -a; fi
if [ -e "/usr/share/zoneinfo/$WREXR_TIMEZONE" ]; then
  ln -sfn "/usr/share/zoneinfo/$WREXR_TIMEZONE" /etc/localtime
  echo "$WREXR_TIMEZONE" > /etc/timezone
  dpkg-reconfigure -f noninteractive tzdata >/dev/null 2>&1 || true
fi
if command -v setupcon >/dev/null 2>&1; then setupcon --save-only >/dev/null 2>&1 || true; fi
EOS

  enable_services
}
