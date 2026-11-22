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
    && rm -rf /var/lib/apt/lists/*

# Node 24 is required for the TypeScript-stripping backend and the config validator.
# Fall back to Debian's nodejs if Nodesource is unreachable in the build network.
RUN if curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource.sh; then \
      bash /tmp/nodesource.sh && apt-get install -y --no-install-recommends nodejs; \
    else \
      apt-get update && apt-get install -y --no-install-recommends nodejs; \
    fi \
    && rm -f /tmp/nodesource.sh \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY . /build/wrexr
WORKDIR /build/wrexr
RUN chmod +x packaging/build-iso.sh installer/wrexr-installer.sh boot/*.sh

VOLUME ["/build/out"]
CMD ["bash", "packaging/build-iso.sh", "--allow-root", "--output", "/build/out"]
