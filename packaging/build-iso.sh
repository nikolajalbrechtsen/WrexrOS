#!/usr/bin/env bash
# WrexrOS ISO builder based on Debian live-build.
# Produces out/WrexrOS-<version>-amd64.iso plus SHA256SUMS.
set -Eeuo pipefail

log_info()  { printf '\033[1;32m[ build ]\033[0m %s\n' "$*" >&2; }
log_warn()  { printf '\033[1;33m[ warn  ]\033[0m %s\n' "$*" >&2; }
log_error() { printf '\033[1;31m[ error ]\033[0m %s\n' "$*" >&2; }
die() { log_error "$*"; exit 1; }

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
readonly BUILD_DIR="${WREXR_BUILD_DIR:-${SCRIPT_DIR}/build}"

OUTPUT_DIR="${WREXR_OUTPUT_DIR:-${REPO_ROOT}/out}"
VERSION="${WREXR_VERSION:-}"
CLEAN_ONLY=0
ALLOW_ROOT=0

# Node 24 is required for native TypeScript execution. Debian bookworm ships
# Node 18, so the runtime is embedded in the ISO and copied into installed systems.
readonly NODE_RUNTIME_VERSION="24.22.3"
readonly NODE_RUNTIME_ARCHIVE="node-v${NODE_RUNTIME_VERSION}-linux-x64.tar.xz"
readonly NODE_RUNTIME_SHA256="4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb"

usage() {
  cat <<'EOF'
Usage: build-iso.sh [--clean] [--output DIR] [--version] [--allow-root] [--help]

  --clean       Remove the live-build working directory and exit.
  --output DIR  Where to place the ISO and SHA256SUMS (default: ../out).
  --version     Print the WrexrOS version that would be built and exit.
  --allow-root  Permit running as root (live-build requires root; the Docker
                image sets WREXR_ALLOW_ROOT=1 instead).
  --help        Show this help.
EOF
}

read_version() {
  [[ -n $VERSION ]] && return 0
  if [[ -r ${REPO_ROOT}/VERSION ]]; then
    VERSION="$(head -n 1 "${REPO_ROOT}/VERSION" | tr -d '\r\n')"
  else
    VERSION="0.1.3"
    log_warn "no ../VERSION file found; using ${VERSION} (set WREXR_VERSION to override)"
  fi
  [[ -n $VERSION ]] || die "version string is empty"
}

parse_args() {
  while (($#)); do
    case "$1" in
      --clean) CLEAN_ONLY=1 ;;
      --output)
        shift
        (($#)) || die "--output requires a directory"
        OUTPUT_DIR="$1"
        ;;
      --output=*) OUTPUT_DIR="${1#*=}" ;;
      --version) read_version; printf 'WrexrOS %s\n' "$VERSION"; exit 0 ;;
      --allow-root) ALLOW_ROOT=1 ;;
      --help|-h) usage; exit 0 ;;
      *) die "unknown option: $1 (try --help)" ;;
    esac
    shift
  done
}

check_root() {
  if ((EUID == 0)) && ((ALLOW_ROOT == 0)) && [[ ${WREXR_ALLOW_ROOT:-0} != 1 ]]; then
    die "live-build needs root; run this script in the Docker image or pass --allow-root"
  fi
}

clean_build_dir() {
  log_info "Cleaning ${BUILD_DIR}"
  rm -rf -- "$BUILD_DIR"
}

prepare_config() {
  command -v lb >/dev/null || die "live-build (lb) is not installed"
  command -v cpio >/dev/null || die "cpio is not installed (live-build needs it for the Debian installer initrd)"
  command -v rsync >/dev/null || die "rsync is not installed"
  command -v sha256sum >/dev/null || die "coreutils sha256sum is not installed"

  if [[ -d ${BUILD_DIR}/config ]]; then
    log_info "Refreshing existing live-build configuration"
    rm -rf -- "${BUILD_DIR}/config"
  fi
  mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"

  local pkg_list="${BUILD_DIR}/config/package-lists/wrexr.list.chroot"
  mkdir -p "$(dirname "$pkg_list")"
  : > "$pkg_list"
  local line pkg
  while IFS= read -r line || [[ -n $line ]]; do
    line="${line%%#*}"
    read -r pkg _ <<< "$line"
    [[ -n ${pkg:-} ]] && printf '%s\n' "$pkg" >> "$pkg_list"
  done < "${SCRIPT_DIR}/packages.list"

  log_info "Configuring live-build for Debian bookworm amd64 (WrexrOS ${VERSION})"
  # Install mode is declared on each menu entry, not globally, so rescue/live
  # boots can never inherit an accidental auto-install default.
  (
    cd "$BUILD_DIR"
    lb config \
      --distribution bookworm \
      --architecture amd64 \
      --debian-installer live \
      --debian-installer-distribution bookworm \
      --debian-installer-gui false \
      --binary-images iso-hybrid \
      --archive-areas 'main contrib non-free non-free-firmware' \
      --firmware-binary true \
      --firmware-chroot true \
      --bootappend-live "boot=live components quiet splash wrexr.version=${VERSION} wrexr.install=" \
      --iso-application 'WrexrOS' \
      --iso-preparer 'WrexrOS Build System' \
      --iso-publisher 'WrexrOS' \
      --iso-volume "WREXR-${VERSION}" \
      --image-name "WrexrOS-${VERSION}-amd64"
  )

  log_info "Installing live-build includes, units and repository content"
  # Bootloader templates must be installed after lb config creates the default
  # config tree so our full ISOLINUX/GRUB menus replace the generated ones.
  if [[ -d ${SCRIPT_DIR}/live-build/config ]]; then
    cp -a "${SCRIPT_DIR}/live-build/config/." "${BUILD_DIR}/config/"
  fi
  mkdir -p \
    "${BUILD_DIR}/config/includes.chroot/etc/wrexr" \
    "${BUILD_DIR}/config/includes.chroot/etc/sudoers.d" \
    "${BUILD_DIR}/config/includes.chroot/etc/systemd/system/multi-user.target.wants" \
    "${BUILD_DIR}/config/includes.chroot/etc/systemd/system/timers.target.wants" \
    "${BUILD_DIR}/config/includes.chroot/usr/lib/systemd/system" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr" \
    "${BUILD_DIR}/config/includes.binary"

  cp -a "${SCRIPT_DIR}/live-build/includes.chroot/." "${BUILD_DIR}/config/includes.chroot/"
  cp -a "${SCRIPT_DIR}/live-build/includes.binary/." "${BUILD_DIR}/config/includes.binary/"

  # A valid example is shipped on the media; users copy/edit it to autospec.json.
  mkdir -p "${BUILD_DIR}/config/includes.binary/wrexr"
  install -m 0644 "${REPO_ROOT}/installer/examples/unattended-standard.json" \
    "${BUILD_DIR}/config/includes.binary/wrexr/autospec.example.json"

  # live-build ships the menu libraries but not the menu COM32 modules themselves.
  # Our isolinux config uses `UI menu.c32`, so copy the modules explicitly.
  local module src
  for module in menu.c32 vesamenu.c32; do
    src="/usr/lib/syslinux/modules/bios/${module}"
    [[ -f $src ]] || die "syslinux module ${module} is missing; install syslinux-common"
    install -m 0644 "$src" "${BUILD_DIR}/config/includes.binary/isolinux/${module}"
  done

  rsync -a \
    --exclude '/.git' --exclude '/packaging/build' --exclude '/packaging/out' \
    --exclude '/node_modules' --exclude '*.iso' \
    "${REPO_ROOT}/" "${BUILD_DIR}/config/includes.chroot/opt/wrexr/"

  # Windows checkouts do not carry executable bits; restore them in the image.
  # This must run after rsync, when the repository files exist in the chroot tree.
  chmod 0755 \
    "${BUILD_DIR}/config/includes.chroot/usr/local/bin/wrexr-live-install" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/installer/wrexr-installer.sh" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/installer/validate-config.mjs" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/installer/functions/"*.sh \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/boot/"*.sh \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/updater/wrexr-update.sh" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/cli/bin/wrexctl"

  # Convenience alias used by the installation docs and the live banner.
  mkdir -p "${BUILD_DIR}/config/includes.chroot/usr/local/bin"
  ln -sfn /opt/wrexr/installer/wrexr-installer.sh \
    "${BUILD_DIR}/config/includes.chroot/usr/local/bin/wrexr-installer"

  install_node_runtime

  local unit
  for unit in "${REPO_ROOT}"/systemd/*.service "${REPO_ROOT}"/systemd/*.timer; do
    [[ -e $unit ]] || continue
    install -m 0644 "$unit" "${BUILD_DIR}/config/includes.chroot/usr/lib/systemd/system/"
  done
  install -m 0644 "${REPO_ROOT}/systemd/00-wrexr.conf" \
    "${BUILD_DIR}/config/includes.chroot/etc/sudoers.d/00-wrexr.conf"
  install -m 0644 "${REPO_ROOT}/boot/wrexr-banner.service" \
    "${BUILD_DIR}/config/includes.chroot/usr/lib/systemd/system/wrexr-banner.service"
  install -m 0644 "${REPO_ROOT}/boot/issue" "${BUILD_DIR}/config/includes.chroot/etc/issue"

  # Only the installer runs in the live image. Appliance units are enabled by
  # the installer on the target system: the live root has no wrexr service
  # account, persistent state or TLS certificate, so wrexrd can only fail there.
  # The first-boot wizard is likewise installed-system only.
  local wants="${BUILD_DIR}/config/includes.chroot/etc/systemd/system/multi-user.target.wants"
  ln -sfn /usr/lib/systemd/system/wrexr-live-install.service \
    "${wants}/wrexr-live-install.service"

  # Docker's storage-driver probe is meaningless on the overlay-backed live
  # root and logs overlayfs "upperdir not supported" warnings. Mask it in the
  # live session; installed systems manage Docker through their own units.
  ln -sfn /dev/null "${BUILD_DIR}/config/includes.chroot/etc/systemd/system/docker.service"
  ln -sfn /dev/null "${BUILD_DIR}/config/includes.chroot/etc/systemd/system/docker.socket"

  # The installed-system banner would advertise a management IP before the
  # installer has configured one. Keep the live console honest instead.
  printf 'WrexrOS %s installer\n\n' "$VERSION" \
    > "${BUILD_DIR}/config/includes.chroot/etc/issue"

  printf '%s\n' "$VERSION" > "${BUILD_DIR}/config/includes.chroot/etc/wrexr/version"
  printf '%s\n' "$VERSION" > "${BUILD_DIR}/config/includes.chroot/opt/wrexr/VERSION"
  chmod 0644 "${BUILD_DIR}/config/includes.chroot/etc/wrexr/version" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/VERSION"

  # Ship locally built .deb files on the ISO at /wrexr/packages.
  if compgen -G "${SCRIPT_DIR}/packages/*.deb" > /dev/null; then
    mkdir -p "${BUILD_DIR}/config/includes.binary/wrexr/packages"
    cp -f "${SCRIPT_DIR}"/packages/*.deb "${BUILD_DIR}/config/includes.binary/wrexr/packages/"
  else
    log_warn "no local *.deb packages in packaging/packages; installer will use Debian packages only"
  fi
}

install_node_runtime() {
  local cache="${BUILD_DIR}/${NODE_RUNTIME_ARCHIVE}"
  local runtime_dir="${BUILD_DIR}/config/includes.chroot/opt/wrexr/runtime"
  local node_dir="${BUILD_DIR}/config/includes.chroot/opt/wrexr-node"
  local bin_dir="${BUILD_DIR}/config/includes.chroot/usr/local/bin"
  local bin

  command -v curl >/dev/null || die "curl is required to fetch the Node.js runtime"
  command -v sha256sum >/dev/null || die "sha256sum is required to verify the Node.js runtime"
  command -v tar >/dev/null || die "tar is required to unpack the Node.js runtime"
  command -v xz >/dev/null || die "xz is required to unpack the Node.js runtime"

  log_info "Installing Node.js ${NODE_RUNTIME_VERSION} runtime in the image"
  if [[ ! -f $cache ]]; then
    curl -fsSL --retry 3 \
      "https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${NODE_RUNTIME_ARCHIVE}" \
      -o "${cache}.tmp"
    printf '%s  %s\n' "$NODE_RUNTIME_SHA256" "${cache}.tmp" | sha256sum -c -
    mv -f "${cache}.tmp" "$cache"
  else
    printf '%s  %s\n' "$NODE_RUNTIME_SHA256" "$cache" | sha256sum -c -
  fi

  mkdir -p "$runtime_dir" "$bin_dir"
  install -m 0644 "$cache" "${runtime_dir}/${NODE_RUNTIME_ARCHIVE}"

  rm -rf -- "$node_dir"
  mkdir -p "$node_dir"
  if ! tar -xJf "$cache" -C "$node_dir" --strip-components=1; then
    die "failed to unpack ${NODE_RUNTIME_ARCHIVE}"
  fi
  for bin in node npm npx corepack; do
    ln -sfn "/opt/wrexr-node/bin/${bin}" "${bin_dir}/${bin}"
  done
}

verify_iso() {
  local iso="$1" path listing eltorito variant found
  command -v xorriso >/dev/null || die "xorriso is required to verify the ISO"
  log_info "Verifying ISO boot catalog and required files"

  eltorito="$(xorriso -indev "$iso" -report_el_torito plain 2>/dev/null || true)"
  grep -Eq 'El Torito boot img[[:space:]]*:[[:space:]]*[0-9]+[[:space:]]+BIOS' <<<"$eltorito" || \
    die "ISO has no BIOS El Torito boot entry"
  grep -Eq 'El Torito boot img[[:space:]]*:[[:space:]]*[0-9]+[[:space:]]+UEFI' <<<"$eltorito" || \
    die "ISO has no UEFI El Torito boot entry"
  grep -qiF '/isolinux/isolinux.bin' <<<"$eltorito" || \
    die "ISO BIOS boot entry does not point to ISOLINUX"

  # live-build bookworm emits /EFI/BOOT/BOOTX64.EFI; newer releases use the
  # lowercase spelling. Accept either so verification follows the real image.
  for path in \
    /isolinux/isolinux.bin \
    /isolinux/ldlinux.c32 \
    /isolinux/menu.c32 \
    /isolinux/libcom32.c32 \
    /isolinux/libutil.c32 \
    /live/vmlinuz \
    /live/initrd.img \
    /EFI/BOOT/BOOTX64.EFI \
    /wrexr/autospec.example.json; do
    found=0
    for variant in \
      "$(basename -- "$path")" \
      "$(basename -- "$path" | tr '[:upper:]' '[:lower:]')" \
      "$(basename -- "$path" | tr '[:lower:]' '[:upper:]')"; do
      listing="$(xorriso -indev "$iso" -find / -type f -name "$variant" 2>/dev/null || true)"
      if [[ -n $listing ]]; then
        found=1
        break
      fi
    done
    ((found)) || die "ISO is missing ${path}"
  done
  log_info "ISO boot verification passed"
}

build_image() {
  log_info "Running lb build (this can take a long time)"
  (cd "$BUILD_DIR" && lb build)

  local iso filename final
  iso="$(find "$BUILD_DIR" -maxdepth 1 -type f -name '*.iso' -print -quit)"
  [[ -n $iso ]] || die "live-build finished but no ISO was produced in ${BUILD_DIR}"
  verify_iso "$iso"
  filename="WrexrOS-${VERSION}-amd64.iso"
  final="${OUTPUT_DIR}/${filename}"
  mv -f "$iso" "$final"
  (
    cd "$OUTPUT_DIR"
    sha256sum "$filename" > SHA256SUMS
  )
  log_info "ISO: ${final}"
  log_info "Checksums: ${OUTPUT_DIR}/SHA256SUMS"
}

main() {
  parse_args "$@"
  read_version
  check_root
  if ((CLEAN_ONLY)); then clean_build_dir; return 0; fi
  prepare_config
  build_image
}

main "$@"
