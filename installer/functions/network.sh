# network.sh - host network, hostname, firewall defaults.
# Sourced by wrexr-installer.sh. All output is written under $TARGET.

netmask_to_prefix() {
  local mask="$1" bits=0 octet
  local IFS='.'
  for octet in $mask; do
    case "$octet" in
      255) bits=$((bits + 8)) ;;
      254) bits=$((bits + 7)) ;;
      252) bits=$((bits + 6)) ;;
      248) bits=$((bits + 5)) ;;
      240) bits=$((bits + 4)) ;;
      224) bits=$((bits + 3)) ;;
      192) bits=$((bits + 2)) ;;
      128) bits=$((bits + 1)) ;;
      0) ;;
      *) log_warn "unusual netmask octet '$octet'; assuming /$bits"; return 0 ;;
    esac
  done
  printf '%s\n' "$bits"
}

network_configure() {
  log_info "Configuring network (${NET_MODE}) on ${NET_IFACE}, bridge ${NET_BRIDGE}"

  local -a iface=(
    'auto lo'
    'iface lo inet loopback'
    ''
    "auto ${NET_IFACE}"
    "iface ${NET_IFACE} inet manual"
    ''
    "auto ${NET_BRIDGE}"
  )
  local -a netplan=(
    'network:'
    '  version: 2'
    '  renderer: networkd'
    "  ethernets:"
    "    ${NET_IFACE}:"
    "      dhcp4: false"
    "  bridges:"
    "    ${NET_BRIDGE}:"
    "      interfaces: [${NET_IFACE}]"
  )

  if [[ $NET_MODE == dhcp ]]; then
    iface+=(
      "iface ${NET_BRIDGE} inet dhcp"
      "    bridge-ports ${NET_IFACE}"
      '    bridge-stp off'
      '    bridge-fd 0'
      '    bridge-vlan-aware yes'
      '    bridge-vids 2-4094'
    )
    netplan+=('      dhcp4: true')
  else
    local prefix
    prefix="$(netmask_to_prefix "$NET_NETMASK")"
    local dns_list=""
    local dns
    for dns in "${NET_DNS[@]}"; do dns_list="${dns_list:+$dns_list }$dns"; done
    iface+=(
      "iface ${NET_BRIDGE} inet static"
      "    address ${NET_ADDRESS}"
      "    netmask ${NET_NETMASK}"
      "    gateway ${NET_GATEWAY}"
      "    dns-nameservers ${dns_list}"
      "    bridge-ports ${NET_IFACE}"
      '    bridge-stp off'
      '    bridge-fd 0'
      '    bridge-vlan-aware yes'
      '    bridge-vids 2-4094'
    )
    netplan+=(
      "      addresses: [${NET_ADDRESS}/${prefix}]"
      "      routes:"
      "        - to: default"
      "          via: ${NET_GATEWAY}"
      "      nameservers:"
      "        addresses: [${dns_list}]"
    )
  fi

  local iface_content netplan_content
  iface_content="$(printf '%s\n' "${iface[@]}")"
  netplan_content="$(printf '%s\n' "${netplan[@]}")"

  write_file "$TARGET/etc/network/interfaces.d/wrexr" "$iface_content" 644
  # Netplan fallback: harmless when ifupdown is used, and ready for cloud images.
  write_file "$TARGET/etc/netplan/99-wrexr.yaml" "$netplan_content" 600
  write_file "$TARGET/etc/hostname" "$CFG_HOSTNAME" 644
  write_file "$TARGET/etc/hosts" "$(printf '%s\n' \
    '127.0.0.1 localhost' \
    "127.0.1.1 ${CFG_HOSTNAME}" \
    '' \
    '# The following lines are desirable for IPv6 capable hosts' \
    '::1     localhost ip6-localhost ip6-loopback' \
    'ff02::1 ip6-allnodes' \
    'ff02::2 ip6-allrouters')" 644

  if [[ $NET_MODE == static ]]; then
    local dns
    local -a resolv=()
    for dns in "${NET_DNS[@]}"; do resolv+=("nameserver $dns"); done
    write_file "$TARGET/etc/resolv.conf" "$(printf '%s\n' "${resolv[@]}")" 644
  fi

  firewall_configure
}

firewall_configure() {
  if [[ $FW_ENABLED != true ]]; then
    log_info "Firewall disabled by configuration (nftables will not be enabled)"
    return 0
  fi
  local ports=""
  local port
  for port in "${FW_PORTS[@]}"; do ports="${ports:+$ports, }$port"; done
  [[ -n $ports ]] || ports="22, ${CFG_UI_PORT}"

  log_info "Writing nftables defaults: inbound TCP { ${ports} }, established traffic and loopback"
  local content
  content="$(printf '%s\n' \
    '#!/usr/sbin/nft -f' \
    '# WrexrOS defaults: allow outbound, allow management inbound, drop the rest.' \
    'flush ruleset' \
    '' \
    'table inet wrexr {' \
    '  chain input {' \
    '    type filter hook input priority 0; policy drop;' \
    '    ct state established,related accept' \
    '    ct state invalid drop' \
    '    iif lo accept' \
    '    ip protocol icmp accept' \
    '    ip6 nexthdr icmpv6 accept' \
    "    tcp dport { ${ports} } ct state new accept" \
    '    udp sport 67 udp dport 68 accept' \
    '    tcp dport 53 accept' \
    '    udp dport 53 accept' \
    '    udp dport 123 accept' \
    '  }' \
    '' \
    '  chain forward {' \
    '    type filter hook forward priority 0; policy accept;' \
    '  }' \
    '' \
    '  chain output {' \
    '    type filter hook output priority 0; policy accept;' \
    '  }' \
    '}')"
  write_file "$TARGET/etc/nftables.conf" "$content" 600
}
