#!/usr/bin/env bash
# Download a published WrexrOS ISO, verify it, and copy it to a Proxmox host.
set -Eeuo pipefail

VERSION="${1:-$(cat "$(dirname "$0")/../VERSION")}"
REPO="nikolajalbrechtsen/WrexrOS"
BASE_URL="https://github.com/${REPO}/releases/download/v${VERSION}"
ISO_NAME="WrexrOS-${VERSION}-amd64.iso"

: "${PROXMOX_HOST:?set PROXMOX_HOST to the Proxmox hostname or IP}"
: "${PROXMOX_USER:?set PROXMOX_USER to the SSH user, normally root}"
: "${PROXMOX_ISO_DIR:?set PROXMOX_ISO_DIR, normally /var/lib/vz/template/iso}"
: "${PROXMOX_SSH_KEY:?set PROXMOX_SSH_KEY to the path of an authorized private key}"

[[ -r $PROXMOX_SSH_KEY ]] || { echo "SSH key is not readable: ${PROXMOX_SSH_KEY}" >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v ssh >/dev/null || { echo "ssh is required" >&2; exit 1; }
command -v scp >/dev/null || { echo "scp is required" >&2; exit 1; }

workdir="$(mktemp -d "${TMPDIR:-/tmp}/wrexr-proxmox-upload.XXXXXX")"
trap 'rm -rf "$workdir"' EXIT

echo "Downloading ${ISO_NAME} and checksums for v${VERSION}"
curl --fail --silent --show-error --location --retry 3 \
  "${BASE_URL}/${ISO_NAME}" -o "${workdir}/${ISO_NAME}"
curl --fail --silent --show-error --location --retry 3 \
  "${BASE_URL}/SHA256SUMS" -o "${workdir}/SHA256SUMS"

(
  cd "$workdir"
  grep -- "  ${ISO_NAME}\$" SHA256SUMS | sha256sum -c -
)

local_sha="$(awk -v name="$ISO_NAME" '$2 == name { print $1; exit }' "${workdir}/SHA256SUMS")"
[[ -n $local_sha ]] || { echo "checksum for ${ISO_NAME} was not found" >&2; exit 1; }

ssh_opts=(
  -i "$PROXMOX_SSH_KEY"
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
)
remote="${PROXMOX_USER}@${PROXMOX_HOST}"

echo "Uploading to ${remote}:${PROXMOX_ISO_DIR}/${ISO_NAME}"
ssh "${ssh_opts[@]}" "$remote" "mkdir -p -- '${PROXMOX_ISO_DIR}'"
scp "${ssh_opts[@]}" "${workdir}/${ISO_NAME}" "${remote}:${PROXMOX_ISO_DIR}/"

remote_sha="$(ssh "${ssh_opts[@]}" "$remote" \
  "sha256sum '${PROXMOX_ISO_DIR}/${ISO_NAME}' | awk '{print \$1}'")"
[[ $remote_sha == "$local_sha" ]] || {
  echo "remote checksum mismatch: expected ${local_sha}, got ${remote_sha}" >&2
  exit 1
}

echo "Uploaded and verified: ${remote}:${PROXMOX_ISO_DIR}/${ISO_NAME}"
ssh "${ssh_opts[@]}" "$remote" "ls -lh '${PROXMOX_ISO_DIR}/${ISO_NAME}'"
