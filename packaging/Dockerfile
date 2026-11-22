# Debian bookworm builder for the WrexrOS live ISO.
# Build:  docker build -t wrexros-builder -f packaging/Dockerfile .
# Run:    docker run --rm --privileged -v "$PWD/out:/build/out" wrexros-builder
FROM debian:bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    WREXR_ALLOW_ROOT=1 \
    WREXR_VERSION=

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      git \
      live-build \
      syslinux-common \
      cpio \
      dosfstools \
      xorriso \
      squashfs-tools \
      rsync \
      qemu-utils \
      grub-efi-amd64-bin \
      jq \
      sudo \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# The builder does not need a system Node.js. build-iso.sh downloads the pinned
# Node 24 runtime directly and embeds it in the image, so no external apt repo
# is required here.

WORKDIR /build
COPY . /build/wrexr
WORKDIR /build/wrexr
RUN chmod +x packaging/build-iso.sh installer/wrexr-installer.sh boot/*.sh

VOLUME ["/build/out"]
CMD ["bash", "packaging/build-iso.sh", "--allow-root", "--output", "/build/out"]
