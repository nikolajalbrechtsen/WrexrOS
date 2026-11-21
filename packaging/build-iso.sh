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
    VERSION="1.0.0"
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
  (
    cd "$BUILD_DIR"
    lb config \
      --distribution bookworm \
      --architecture amd64 \
      --debian-installer live \
      --debian-installer-distribution bookworm \
      --debian-installer-gui false \
      --binary-images iso-hybrid \
      --archive-areas 'main contrib non-free' \
      --bootappend-live "boot=live components quiet splash wrexr.version=${VERSION} wrexr.install=standard" \
      --iso-application 'WrexrOS' \
      --iso-preparer 'WrexrOS Build System' \
      --iso-publisher 'WrexrOS' \
      --iso-volume "WREXR-${VERSION}" \
      --image-name "WrexrOS-${VERSION}-amd64"
  )

  log_info "Installing live-build includes, units and repository content"
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

  local unit
  for unit in "${REPO_ROOT}"/systemd/*.service; do
    install -m 0644 "$unit" "${BUILD_DIR}/config/includes.chroot/usr/lib/systemd/system/"
  done
  install -m 0644 "${REPO_ROOT}/systemd/00-wrexr.conf" \
    "${BUILD_DIR}/config/includes.chroot/etc/sudoers.d/00-wrexr.conf"
  install -m 0644 "${REPO_ROOT}/boot/wrexr-banner.service" \
    "${BUILD_DIR}/config/includes.chroot/usr/lib/systemd/system/wrexr-banner.service"
  install -m 0644 "${REPO_ROOT}/boot/issue" "${BUILD_DIR}/config/includes.chroot/etc/issue"

  # Enable the appliance units in the live image (symlinks live in /etc/systemd).
  local wants="${BUILD_DIR}/config/includes.chroot/etc/systemd/system/multi-user.target.wants"
  for unit in wrexrd.service wrexr-console.service wrexr-banner.service \
              wrexr-firstboot.service wrexr-live-install.service; do
    ln -sfn "/usr/lib/systemd/system/${unit}" "${wants}/${unit}"
  done
  ln -sfn /usr/lib/systemd/system/wrexr-updater.timer \
    "${BUILD_DIR}/config/includes.chroot/etc/systemd/system/timers.target.wants/wrexr-updater.timer"

  printf '%s\n' "$VERSION" > "${BUILD_DIR}/config/includes.chroot/etc/wrexr/version"
  printf '%s\n' "$VERSION" > "${BUILD_DIR}/config/includes.chroot/opt/wrexr/VERSION"
  chmod 0644 "${BUILD_DIR}/config/includes.chroot/etc/wrexr/version" \
    "${BUILD_DIR}/config/includes.chroot/opt/wrexr/VERSION"

  # Ship locally built .deb files on the ISO at /cdrom/wrexr/packages.
  if compgen -G "${SCRIPT_DIR}/packages/*.deb" > /dev/null; then
    mkdir -p "${BUILD_DIR}/config/includes.binary/wrexr/packages"
    cp -f "${SCRIPT_DIR}"/packages/*.deb "${BUILD_DIR}/config/includes.binary/wrexr/packages/"
  else
    log_warn "no local *.deb packages in packaging/packages; installer will use Debian packages only"
  fi
}

build_image() {
  log_info "Running lb build (this can take a long time)"
  (cd "$BUILD_DIR" && lb build)

  local iso filename final
  iso="$(find "$BUILD_DIR" -maxdepth 1 -type f -name '*.iso' -print -quit)"
  [[ -n $iso ]] || die "live-build finished but no ISO was produced in ${BUILD_DIR}"
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
