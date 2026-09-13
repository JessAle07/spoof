#!/bin/sh
# tun2socks-router - L3 router giving each downstream container its own exit IP.
#
# Downstream containers sit on a bridge whose gateway is this host. Every packet
# they emit - any process, any protocol, nothing configured inside them - is
# forwarded here and steered into a tunnel chosen by SOURCE IP.
set -eu

log() { printf '%s [router] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "FATAL: $*"; exit 1; }

ROUTES_FILE="${ROUTES_FILE:-/etc/tun2socks/routes.conf}"
LAN_IF="${LAN_IF:-vmbr1}"
LAN_ADDR="${LAN_ADDR:-}"
LOG_LEVEL="${LOG_LEVEL:-info}"
DNS_UPSTREAM="${DNS_UPSTREAM:-1.1.1.1:53}"
DNS_LISTEN="${DNS_LISTEN:-}"
TUN_MTU="${TUN_MTU:-1500}"
UDP_TIMEOUT="${UDP_TIMEOUT:-60s}"

# Tunnel engine:
#   tun2socks - Go/gVisor. Handles socks5, http, https, shadowsocks, relay.
#   hev       - C/lwIP. SOCKS5 only, but Fullcone NAT for UDP, lower CPU and
#               memory, and IPv6 dual stack. Better for P2P and UDP-heavy work.
ENGINE="${ENGINE:-tun2socks}"
HEV_UDP_MODE="${HEV_UDP_MODE:-udp}"   # udp = RFC1928 UDP ASSOCIATE; tcp = UDP-in-TCP
# hev's own timeouts, milliseconds. Residential and ISP proxies are often slow
# to complete a handshake under load; the stock values give up early and the
# log fills with "io timeout".
HEV_CONNECT_TIMEOUT="${HEV_CONNECT_TIMEOUT:-15000}"
HEV_RW_TIMEOUT="${HEV_RW_TIMEOUT:-120000}"
HEV_LIMIT_NOFILE="${HEV_LIMIT_NOFILE:-65535}"
HEV_CONF_DIR="${HEV_CONF_DIR:-/run/tun2socks}"

# What to do with client UDP:
#   tunnel - push it through the proxy (correct when the proxy carries UDP)
#   reject - answer ICMP port-unreachable immediately
#   drop   - silently discard
#
# 'reject' is the right choice when the upstream proxy has no UDP support. If
# UDP is silently blackholed, applications sit and wait for a reply that never
# comes, which is what "most things work but some features are broken" feels
# like. Rejected instead, QUIC falls back to HTTP/2 over TCP straight away and
# most other protocols take their TCP path too.
UDP_POLICY="${UDP_POLICY:-tunnel}"

# What happens to a LAN client with no routes.conf entry:
#   direct - it is none of our business; leave it completely alone (default)
#   block  - drop its traffic and refuse its DNS
#
# 'direct' is the default because LAN_IF is very often a shared LAN carrying
# machines that have nothing to do with the proxies. Only use 'block' when the
# bridge is dedicated to proxied clients and you want a hard killswitch.
UNMAPPED_POLICY="${UNMAPPED_POLICY:-direct}"

# Host-wide and rarely needed. Off by default; set to 1 only if asymmetric
# routing on the LAN side actually requires it.
RELAX_RP_FILTER="${RELAX_RP_FILTER:-0}"

# Policy tables and priorities live in a private high range so they cannot
# collide with rules installed by the distro, Proxmox, systemd-networkd or
# anything else on the host. 100-354 is far too crowded to be safe.
BASE_TABLE="${BASE_TABLE:-10000}"
BASE_PRIO="${BASE_PRIO:-10000}"

# Tunnel endpoints come from 198.18.0.0/15 (RFC 2544 benchmarking range), which
# is reserved and will not clash with real destinations.
TUN_OCT_A=198
TUN_OCT_B=18

[ -f "$ROUTES_FILE" ] || die "routes file $ROUTES_FILE not found (mount it read-only)"

case "$UNMAPPED_POLICY" in
  direct|block) ;;
  *) die "UNMAPPED_POLICY must be direct or block; got '$UNMAPPED_POLICY'" ;;
esac

case "$UDP_POLICY" in
  tunnel|reject|drop) ;;
  *) die "UDP_POLICY must be tunnel, reject or drop; got '$UDP_POLICY'" ;;
esac

case "$ENGINE" in
  tun2socks|hev) ;;
  *) die "ENGINE must be 'tun2socks' or 'hev', got '$ENGINE'" ;;
esac
command -v "$( [ "$ENGINE" = hev ] && echo hev-socks5-tunnel || echo tun2socks )" >/dev/null 2>&1 \
  || die "engine '$ENGINE' is not installed in this image"

# hev opens a dual-stack (AF_INET6) socket for its upstream connection even when
# the proxy and all traffic are IPv4. Verified by strace:
#   socket(AF_INET6, SOCK_STREAM|SOCK_NONBLOCK, IPPROTO_IP) = -1 EAFNOSUPPORT
# followed by an opaque "socks5 client socket" error on every connection.
#
# This is about the address family existing, NOT about having IPv6
# connectivity - a host with the ipv6 module loaded and no IPv6 address at all
# passes fine. Only ipv6.disable=1 at boot breaks it.
if [ "$ENGINE" = "hev" ]; then
  if ! dnsrouter -check-inet6 >/dev/null 2>&1; then
    die "ENGINE=hev cannot run: this kernel refuses AF_INET6 sockets.
       hev uses a dual-stack socket to reach the proxy even for IPv4-only work,
       so it cannot connect to anything here. You do NOT need IPv6 addresses or
       routes - only the address family.
       Fix: remove 'ipv6.disable=1' from the kernel command line and reboot,
       or keep ENGINE=tun2socks, which uses AF_INET throughout."
  fi
fi

# urldecode - tun2socks parses the URL and decodes %40 etc. for you; hev takes
# the credential raw out of YAML, so it has to be decoded here or the proxy sees
# the literal "p%40ss" instead of "p@ss".
urldecode() {
  _s="$1"; _out=""
  while [ -n "$_s" ]; do
    case "$_s" in
      %[0-9A-Fa-f][0-9A-Fa-f]*)
        _hex="${_s#%}"; _hex="${_hex%"${_hex#??}"}"
        _out="${_out}$(printf "\\$(printf '%03o' "0x${_hex}")")"
        _s="${_s#%??}" ;;
      *)
        _out="${_out}${_s%"${_s#?}"}"; _s="${_s#?}" ;;
    esac
  done
  printf '%s' "$_out"
}

# yamlq - single-quoted YAML escapes an embedded quote by doubling it.
yamlq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

# split_proxy <url> -> sets PX_SCHEME PX_HOST PX_PORT PX_USER PX_PASS
# hev wants the parts separately, unlike tun2socks which takes the whole URL.
split_proxy() {
  _u="$1"
  PX_SCHEME="${_u%%://*}"
  _rest="${_u#*://}"
  _hostport="${_rest##*@}"
  _cred=""
  case "$_rest" in *@*) _cred="${_rest%@*}" ;; esac
  PX_USER="${_cred%%:*}"
  PX_PASS=""
  case "$_cred" in *:*) PX_PASS="${_cred#*:}" ;; esac
  [ -n "$_cred" ] || { PX_USER=""; PX_PASS=""; }
  _hostport="${_hostport%%/*}"
  PX_HOST="${_hostport%:*}"
  PX_PORT="${_hostport##*:}"
  PX_USER="$(urldecode "$PX_USER")"
  PX_PASS="$(urldecode "$PX_PASS")"
}

# tun_addr <index> -> a unique /32, walking across /24s so the number of
# tunnels is not capped at 254.
#   index 0   -> 198.18.0.1     index 253 -> 198.18.0.254
#   index 254 -> 198.18.1.1     index 507 -> 198.18.1.254
tun_addr() {
  _idx="$1"
  _third=$(( _idx / 254 ))
  _fourth=$(( _idx % 254 + 1 ))
  [ "$_third" -le 255 ] || die "too many routes: index $_idx exceeds the 198.18.0.0/15 tunnel range"
  printf '%s.%s.%s.%s' "$TUN_OCT_A" "$TUN_OCT_B" "$_third" "$_fourth"
}

# ------------------------------------------------------------- kernel plumbing
if ! sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1; then
  [ "$(cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo 0)" = "1" ] \
    || die "cannot enable ip_forward - the container needs NET_ADMIN"
fi

# net.ipv4.conf.all.rp_filter is host-wide, so this stays opt-in.
if [ "$RELAX_RP_FILTER" = "1" ]; then
  if sysctl -w net.ipv4.conf.all.rp_filter=2 >/dev/null 2>&1; then
    log "relaxed net.ipv4.conf.all.rp_filter to 2 (RELAX_RP_FILTER=1)"
  fi
fi

# This container uses network_mode: host, so the FORWARD chain belongs to the
# HOST - flushing it would wipe Docker's and Proxmox's own rules. Keep our rules
# in a private chain and only ever flush that.
iptables -N TUN2SOCKS_FWD 2>/dev/null || true
iptables -F TUN2SOCKS_FWD
iptables -C FORWARD -j TUN2SOCKS_FWD 2>/dev/null || iptables -I FORWARD 1 -j TUN2SOCKS_FWD

mkdir -p "$HEV_CONF_DIR"
chmod 700 "$HEV_CONF_DIR"
mkdir -p /dev/net
[ -c /dev/net/tun ] || mknod /dev/net/tun c 10 200

ip link show "$LAN_IF" >/dev/null 2>&1 \
  || die "LAN interface '$LAN_IF' does not exist on this host (set LAN_IF)"

if [ -n "$LAN_ADDR" ]; then
  ip addr replace "$LAN_ADDR" dev "$LAN_IF"
  log "LAN address $LAN_ADDR on $LAN_IF"
fi
ip link set dev "$LAN_IF" up

LAN_IP="$(ip -4 -o addr show dev "$LAN_IF" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
[ -n "$LAN_IP" ] || die "$LAN_IF has no IPv4 address; set LAN_ADDR or configure the bridge first"

# Bind DNS to the LAN address only. With network_mode: host, 0.0.0.0:53 would
# claim port 53 on the WAN interface too - both a conflict risk and an open
# resolver facing the internet.
[ -n "$DNS_LISTEN" ] || DNS_LISTEN="${LAN_IP}:53"

log "engine=$ENGINE  LAN $LAN_IF ($LAN_IP)  tables ${BASE_TABLE}+  priorities ${BASE_PRIO}+"
[ "$ENGINE" = "hev" ] && log "hev UDP mode: $HEV_UDP_MODE (fullcone NAT), connect ${HEV_CONNECT_TIMEOUT}ms, rw ${HEV_RW_TIMEOUT}ms"

# --------------------------------------------------------- one tunnel per proxy
PIDS=""
INDEX=0
OFFLAN=0

while IFS= read -r LINE || [ -n "$LINE" ]; do
  LINE="$(printf '%s' "$LINE" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  case "$LINE" in ''|\#*) continue ;; esac

  CLIENT_IP="$(printf '%s' "$LINE" | awk '{print $1}')"
  PROXY_URL="$(printf '%s' "$LINE" | awk '{print $2}')"
  [ -n "$CLIENT_IP" ] && [ -n "$PROXY_URL" ] || die "bad line in $ROUTES_FILE: $LINE"

  DEV="ts$INDEX"
  TABLE=$((BASE_TABLE + INDEX))
  PRIO=$((BASE_PRIO + INDEX))
  ADDR="$(tun_addr "$INDEX")"

  if [ "$ENGINE" = "tun2socks" ]; then
    ip tuntap add mode tun dev "$DEV" 2>/dev/null || true
    # /32: each tunnel needs an endpoint address, not a subnet. Using /24s here
    # would create hundreds of overlapping connected routes.
    ip addr replace "$ADDR/32" dev "$DEV"
    ip link set dev "$DEV" mtu "$TUN_MTU" up
  fi
  # hev creates and addresses the device itself, so its route and rule are
  # installed from a post-up script once the interface actually exists.

  ip route replace default dev "$DEV" table "$TABLE" 2>/dev/null || true

  # 'iif $LAN_IF' is load-bearing. Without it the rule also matches traffic the
  # HOST originates, sending the host's own packets into a proxy tunnel and
  # taking the machine off the internet. Restricting to packets forwarded in
  # from the LAN bridge leaves host routing untouched.
  ip rule del priority "$PRIO" 2>/dev/null || true
  ip rule add iif "$LAN_IF" from "$CLIENT_IP" lookup "$TABLE" priority "$PRIO"

  # UDP handling comes first so it wins over the tunnel ACCEPT below.
  # Traffic addressed to the router itself (DNS) goes to INPUT, not FORWARD, so
  # dnsrouter keeps working over TCP regardless of this setting.
  case "$UDP_POLICY" in
    reject)
      iptables -A TUN2SOCKS_FWD -i "$LAN_IF" -s "$CLIENT_IP" -p udp \
               -j REJECT --reject-with icmp-port-unreachable ;;
    drop)
      iptables -A TUN2SOCKS_FWD -i "$LAN_IF" -s "$CLIENT_IP" -p udp -j DROP ;;
  esac

  # Docker sets the host FORWARD policy to DROP, so permit exactly this
  # client's traffic in and out of its own tunnel - nothing wider.
  iptables -A TUN2SOCKS_FWD -i "$LAN_IF" -s "$CLIENT_IP" -o "$DEV" -j ACCEPT
  iptables -A TUN2SOCKS_FWD -i "$DEV" -d "$CLIENT_IP" -o "$LAN_IF" -j ACCEPT

  if ! ip route get "$CLIENT_IP" 2>/dev/null | head -1 | grep -q "dev $LAN_IF"; then
    OFFLAN=$((OFFLAN + 1))
  fi

  if [ "$ENGINE" = "tun2socks" ]; then
    tun2socks --device "tun://$DEV" --proxy "$PROXY_URL" \
              --loglevel "$LOG_LEVEL" --udp-timeout "$UDP_TIMEOUT" &
    PIDS="$PIDS $!"
  else
    split_proxy "$PROXY_URL"
    case "$PX_SCHEME" in
      socks5|socks5h) ;;
      *) die "ENGINE=hev speaks SOCKS5 only, but $CLIENT_IP uses '$PX_SCHEME://'.
       Use a socks5:// upstream for that client, or set ENGINE=tun2socks." ;;
    esac

    cat > "$HEV_CONF_DIR/$DEV.sh" <<EOS
#!/bin/sh
ip link set dev $DEV mtu $TUN_MTU up
ip route replace default dev $DEV table $TABLE
EOS
    chmod +x "$HEV_CONF_DIR/$DEV.sh"

    {
      echo "tunnel:"
      echo "  name: $DEV"
      echo "  mtu: $TUN_MTU"
      echo "  ipv4: $ADDR"
      echo "  post-up-script: $HEV_CONF_DIR/$DEV.sh"
      echo "socks5:"
      echo "  address: '$PX_HOST'"
      echo "  port: $PX_PORT"
      echo "  udp: '$HEV_UDP_MODE'"
      [ -n "$PX_USER" ] && echo "  username: $(yamlq "$PX_USER")"
      [ -n "$PX_PASS" ] && echo "  password: $(yamlq "$PX_PASS")"
      echo "misc:"
      echo "  log-level: $LOG_LEVEL"
      echo "  log-file: stderr"
      echo "  connect-timeout: $HEV_CONNECT_TIMEOUT"
      echo "  read-write-timeout: $HEV_RW_TIMEOUT"
      echo "  limit-nofile: $HEV_LIMIT_NOFILE"
    } > "$HEV_CONF_DIR/$DEV.yml"
    chmod 600 "$HEV_CONF_DIR/$DEV.yml"

    hev-socks5-tunnel "$HEV_CONF_DIR/$DEV.yml" &
    PIDS="$PIDS $!"
  fi

  if [ "$INDEX" -lt 8 ] || [ $((INDEX % 50)) -eq 0 ]; then
    log "$CLIENT_IP -> $DEV ($ADDR, table $TABLE) -> $(printf '%s' "$PROXY_URL" | sed 's|://[^@]*@|://***:***@|')"
  fi
  INDEX=$((INDEX + 1))
done < "$ROUTES_FILE"

[ "$INDEX" -gt 0 ] || die "no usable routes in $ROUTES_FILE"
[ "$OFFLAN" -eq 0 ] || log "WARNING: $OFFLAN client IP(s) are not reachable via $LAN_IF - check the bridge subnet"

# ------------------------------------------------------------------------- DNS
# Resolution must exit through the same proxy as the traffic, or names resolve
# in this host's location instead of the client's.
DNS_UNMAPPED=direct
[ "$UNMAPPED_POLICY" = "block" ] && DNS_UNMAPPED=refuse
dnsrouter -listen "$DNS_LISTEN" -routes "$ROUTES_FILE" -upstream "$DNS_UPSTREAM" \
          -unmapped "$DNS_UNMAPPED" -dns-mode "${DNS_MODE:-proxy}" -doh-provider "${DNS_PROVIDER:-cloudflare}" &
PIDS="$PIDS $!"

if [ "$UNMAPPED_POLICY" = "block" ]; then
  # Only meaningful on a dedicated bridge. Drops anything from the client
  # subnet that is not entering one of our tunnels.
  LAN_CIDR="$(ip -4 -o addr show dev "$LAN_IF" 2>/dev/null | awk '{print $4}' | head -1)"
  if [ -n "$LAN_CIDR" ]; then
    iptables -A TUN2SOCKS_FWD -i "$LAN_IF" -s "$LAN_CIDR" -o "$LAN_IF" -j DROP
    iptables -A TUN2SOCKS_FWD -i "$LAN_IF" -s "$LAN_CIDR" -j DROP
    log "unmapped policy: BLOCK - clients on $LAN_CIDR without a routes.conf entry are cut off"
  fi
else
  log "unmapped policy: direct - other machines on $LAN_IF are untouched"
fi

case "$UDP_POLICY" in
  reject) log "UDP policy: reject (clients get ICMP unreachable and fall back to TCP)" ;;
  drop)   log "UDP policy: drop" ;;
esac
printf "%s\n" "$PIDS" > /run/ea-pids
touch /run/ea-ready
log "router ready: $INDEX tunnels, DNS on $DNS_LISTEN"

# -------------------------------------------------------------------- supervise
# Remove exactly what we created - by priority and table number, never by a
# broad match that could delete somebody else's rules.
cleanup() {
  rm -f /run/ea-ready
  log "shutting down"
  kill $PIDS 2>/dev/null || true
  I=0
  while [ "$I" -lt "$INDEX" ]; do
    ip rule del priority $((BASE_PRIO + I)) 2>/dev/null || true
    ip route flush table $((BASE_TABLE + I)) 2>/dev/null || true
    ip link del "ts$I" 2>/dev/null || true
    rm -f "$HEV_CONF_DIR/ts$I.yml" "$HEV_CONF_DIR/ts$I.sh" 2>/dev/null || true
    I=$((I + 1))
  done
  iptables -D FORWARD -j TUN2SOCKS_FWD 2>/dev/null || true
  iptables -F TUN2SOCKS_FWD 2>/dev/null || true
  iptables -X TUN2SOCKS_FWD 2>/dev/null || true
  log "host routing state removed"
}
trap 'cleanup; exit 0' TERM INT

# If a tunnel dies its clients would silently fall back to the host's own route
# and leak. Take the whole router down instead and let Docker restart it.
while true; do
  for PID in $PIDS; do
    if ! kill -0 "$PID" 2>/dev/null; then
      log "component $PID exited - stopping router to avoid leaking traffic"
      cleanup
      exit 1
    fi
  done
  sleep 3
done
