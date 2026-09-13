#!/bin/sh
set -eu
rm -f /run/ea-ready /run/ea-pids
# These rules live ONLY in this router container's network namespace.
iptables -P FORWARD DROP
iptables -P INPUT DROP
iptables -F INPUT
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
LAN_IF="$(ip -4 -o addr show | awk -v wanted="$EA_ROUTER_IP" '{split($4,a,"/"); if(a[1]==wanted) print $2}')"
[ -n "$LAN_IF" ] || { echo 'Router LAN address missing'; exit 1; }
export LAN_IF
for f in /proc/sys/net/ipv4/conf/*/rp_filter; do echo 0 > "$f" 2>/dev/null || true; done
iptables -A INPUT -i "$LAN_IF" -p udp --dport 53 -j ACCEPT
iptables -A INPUT -i "$LAN_IF" -p tcp --dport 53 -j ACCEPT
exec /usr/local/bin/entrypoint.sh
