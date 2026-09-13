#!/usr/bin/env bash
# Bash 4.3+, Docker CLI, coreutils and util-linux (flock). No Python or jq.
set -Eeuo pipefail
ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
DATA="$ROOT/ea-launcher-data"
LABEL=io.earnapp.bash-launcher
ROUTER_IMAGE=tun2socks-router:latest
EARNAPP_IMAGE=multiplatform-earnapp:latest
OWNER=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
DNS_MODE=dns-leak
DNS_PROVIDER=cloudflare
WORKER_PREFIX=ea
PLATFORM_LIST=
CONFIG_OWNER=$OWNER
ROUTER_ID=$ROUTER_IMAGE
declare -a WORKER_PLATFORMS=() SELECTED_PLATFORMS=()
declare -a IPS=() PROXIES=() DESIRED=() LINKS=() POOL=()
err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
ask() {
    local answer
    printf '%s%s: ' "$2" "${3:+ [$3]}" >&2
    IFS= read -r answer || err 'Input ended.'
    printf -v "$1" '%s' "${answer:-${3:-}}"
}
ipnum() {
    local a b c d part
    [[ $1 =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]] || return 1
    IFS=. read -r a b c d <<< "$1"
    for part in "$a" "$b" "$c" "$d"; do ((10#$part <= 255)) || return 1; done
    printf '%s\n' "$(( (10#$a << 24) | (10#$b << 16) | (10#$c << 8) | 10#$d ))"
}
ipstr() { printf '%d.%d.%d.%d' "$((($1>>24)&255))" "$((($1>>16)&255))" "$((($1>>8)&255))" "$(($1&255))"; }
# Returns NETNUM, BROADCAST, PREFIX, MASK and CANON in this shell.
parse_net() {
    local address bits number
    [[ $1 == */* ]] || err 'Subnet must have a CIDR prefix, e.g. 172.28.0.0/24.'
    address=${1%/*}; bits=${1##*/}
    [[ $bits =~ ^[0-9]{1,2}$ ]] || err 'Invalid prefix.'
    PREFIX=$((10#$bits)); ((PREFIX >= 0 && PREFIX <= 32)) || err 'Prefix must be /0 through /32.'
    number=$(ipnum "$address") || err 'Invalid subnet IPv4.'
    local masknum=$(( (4294967295 << (32-PREFIX)) & 4294967295 ))
    NETNUM=$((number & masknum)); BROADCAST=$((NETNUM | (4294967295 ^ masknum)))
    MASK=$(ipstr "$masknum"); CANON="$(ipstr "$NETNUM")/$PREFIX"
}
valid_host() {
    local value
    value=$(ipnum "$1") || err "Invalid IPv4 address: $1"
    ((value > NETNUM && value < BROADCAST)) || err "Address outside usable subnet: $1"
}
make_pool() {
    parse_net "$SUBNET"
    ((PREFIX >= 16 && PREFIX <= 29)) || err 'Worker subnet must be /16 through /29.'
    [[ $NETMASK == "$MASK" ]] || err 'Netmask does not match CIDR prefix.'
    local g r s e x
    valid_host "$BRIDGE_IP"; valid_host "$ROUTER_IP"; valid_host "$FIRST_IP"; valid_host "$LAST_IP"
    g=$(ipnum "$BRIDGE_IP"); r=$(ipnum "$ROUTER_IP"); s=$(ipnum "$FIRST_IP"); e=$(ipnum "$LAST_IP")
    ((g != r && s <= e)) || err 'Gateways must differ and first IP must not exceed last IP.'
    POOL=()
    for ((x=s;x<=e;x++)); do
        if ((x != g && x != r && (x&255) != 0 && (x&255) != 1 && (x&255) != 255)); then
            POOL+=("$(ipstr "$x")")
        fi
    done
}
urlencode() {
    local LC_ALL=C c hex i
    for ((i=0;i<${#1};i++)); do
        c=${1:i:1}
        case "$c" in [a-zA-Z0-9.~_-]) printf '%s' "$c";; *) printf -v hex '%%%02X' "'$c"; printf '%s' "$hex";; esac
    done
}
# Normalizes a proxy into REPLY; no eval and no credential-bearing shell commands.
normalize_proxy() {
    local value=$1 scheme rest hostport credentials host port user pass
    [[ -n $value && ! $value =~ [[:space:][:cntrl:]] ]] || return 1
    if [[ $value != *://* ]]; then
        if [[ $value =~ ^([^:]+):([0-9]+):([^:]+):(.+)$ ]]; then
            value="socks5://$(urlencode "${BASH_REMATCH[3]}"):$(urlencode "${BASH_REMATCH[4]}")@${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
        elif [[ $value =~ ^[^:]+:[0-9]+$ ]]; then value="socks5://$value"
        else return 1; fi
    fi
    scheme=${value%%://*}; rest=${value#*://}; rest=${rest%/}
    [[ $scheme == socks5 || $scheme == http ]] || return 1
    [[ $rest != *'/'* && $rest != *'?'* && $rest != *'#'* ]] || return 1
    hostport=${rest##*@}
    if [[ $rest == *@* ]]; then
        credentials=${rest%@*}
        [[ $credentials != *@* && $credentials == *:* ]] || return 1
        user=${credentials%%:*}; pass=${credentials#*:}
        [[ -n $user && -n $pass ]] || return 1
    fi
    [[ $hostport =~ ^([0-9.]+):([0-9]{1,5})$ ]] || return 1
    host=${BASH_REMATCH[1]}; port=${BASH_REMATCH[2]}
    ipnum "$host" >/dev/null || return 1
    ((10#$port > 0 && 10#$port <= 65535)) || return 1
    REPLY="$scheme://$rest"
}
exists() { docker "$1" inspect "$2" >/dev/null 2>&1; }
check_owned() {
    local kind=$1 name=$2 owner template
    exists "$kind" "$name" || return 0
    if [[ $kind == container ]]; then template="{{index .Config.Labels \"$LABEL\"}}"
    else template="{{index .Labels \"$LABEL\"}}"; fi
    owner=$(docker "$kind" inspect -f "$template" "$name")
    [[ $owner == "$OWNER" ]] || err "$kind '$name' belongs to another deployment; refusing to modify it."
}
save() {
    local key i
    CONFIG_OWNER=$OWNER
    PLATFORM_LIST=${PLATFORM_LIST:-$PLATFORM}
    {
        for key in CONFIG_OWNER WORKER_PREFIX PLATFORM_LIST ROUTER_ID NAME MODE SUBNET NETMASK BRIDGE_IP ROUTER_IP FIRST_IP LAST_IP DNS DNS_MODE DNS_PROVIDER WAN_SUBNET WAN_GATEWAY LAN WAN ROUTER WORKER_IMAGE BASE_ID WRAPPER_IMAGE PLATFORM UDP; do
            printf 'K\t%s\t%s\n' "$key" "${!key}"
        done
        for ((i=0;i<${#IPS[@]};i++)); do
            printf 'W\t%d\t%s\t%s\t%s\t%s\t%s\n' "$i" "${IPS[i]}" "${PROXIES[i]}" "${DESIRED[i]}" "${LINKS[i]:--}" "$(worker_platform "$i")"
        done
    } > "$DATA/config.tsv.tmp"
    mv -f -- "$DATA/config.tsv.tmp" "$DATA/config.tsv"
}
load() {
    [[ -f $DATA/config.tsv ]] || err 'Run setup first.'
    local type key value proxy desired link workerplatform
    IPS=(); PROXIES=(); DESIRED=(); LINKS=()
    DNS_MODE=proxy;DNS_PROVIDER=cloudflare
    WORKER_PREFIX=ea; CONFIG_OWNER=$OWNER; PLATFORM_LIST=; ROUTER_ID=$ROUTER_IMAGE; WORKER_PLATFORMS=()
    while IFS=$'\t' read -r type key value proxy desired link workerplatform; do
        case "$type" in
            K) case "$key" in
                CONFIG_OWNER|WORKER_PREFIX|PLATFORM_LIST|ROUTER_ID|NAME|MODE|SUBNET|NETMASK|BRIDGE_IP|ROUTER_IP|FIRST_IP|LAST_IP|DNS|DNS_MODE|DNS_PROVIDER|WAN_SUBNET|WAN_GATEWAY|LAN|WAN|ROUTER|WORKER_IMAGE|BASE_ID|WRAPPER_IMAGE|PLATFORM|UDP)
                    printf -v "$key" '%s' "$value";; *) err 'Unknown configuration key.';; esac;;
            W) [[ $key == "${#IPS[@]}" ]] || err 'Invalid worker ordering in configuration.'
               IPS+=("$value"); PROXIES+=("$proxy"); DESIRED+=("$desired"); LINKS+=("${link:--}"); WORKER_PLATFORMS+=("${workerplatform:-$PLATFORM}");;
            *) err 'Invalid configuration record.';;
        esac
    done < "$DATA/config.tsv"
    [[ $CONFIG_OWNER == "$OWNER" ]] || err "This configuration belongs to another folder. Restart the launcher to initialize this copy."
    PLATFORM_LIST=${PLATFORM_LIST:-$PLATFORM}
    ((${#IPS[@]} > 0)) || err 'No workers in configuration.'
}
check_overlap() {
    local wanted=$1 other netid low high on ob
    parse_net "$wanted"; low=$NETNUM; high=$BROADCAST
    local ids; ids=$(docker network ls -q)
    for netid in $ids; do
        local subnets; subnets=$(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "$netid")
        while IFS= read -r other; do
            [[ -z $other || $other == *:* || $other == 0.0.0.0/0 ]] && continue
            parse_net "$other"; on=$NETNUM; ob=$BROADCAST
            ((low > ob || high < on)) || err "Subnet $wanted overlaps Docker network $netid ($other)."
        done <<< "$subnets"
    done
    if command -v ip >/dev/null; then
        local routes; routes=$(ip -4 route show table all)
        while read -r other _; do
            [[ $other == */* && $other != 0.0.0.0/0 ]] || continue
            parse_net "$other"; on=$NETNUM; ob=$BROADCAST
            ((low > ob || high < on)) || err "Subnet $wanted overlaps host route $other."
        done <<< "$routes"
    fi
}
write_routes() {
    local i
    for ((i=0;i<${#IPS[@]};i++)); do printf '%s %s\n' "${IPS[i]}" "${PROXIES[i]}"; done > "$DATA/routes.conf.tmp"
    mv -f -- "$DATA/routes.conf.tmp" "$DATA/routes.conf"
    # Keep the resolver inode stable for already-created bind mounts.
    printf 'nameserver %s\noptions timeout:3 attempts:2\n' "$ROUTER_IP" > "$DATA/resolv.conf"
    chmod 644 "$DATA/resolv.conf"
}
worker_name() { printf '%s-%d' "$WORKER_PREFIX" "$(($1+1))"; }
worker_platform() { printf '%s' "${WORKER_PLATFORMS[$1]:-$PLATFORM}"; }
normalize_platform() {
    case "${1,,}" in
        window|windows|win) REPLY=win;; mac|macos) REPLY=mac;;
        linux|ios|tizen|webos|default) REPLY=${1,,};;
        *) return 1;;
    esac
}
select_platforms() {
    local multiple count chosen i
    ask multiple 'Use multiple platforms? yes / no' no
    SELECTED_PLATFORMS=()
    case "${multiple,,}" in
        y|yes)
            printf 'Available: linux, mac, win (windows), ios, tizen, webos, default\n'
            ask count 'How many platforms?' 2
            [[ $count =~ ^[1-7]$ ]] && ((count>=2)) || err 'Choose 2 through 7 platforms.'
            for ((i=0;i<count;i++)); do
                ask chosen "Platform $((i+1))" "$([[ $i == 0 ]] && printf tizen || printf win)"
                normalize_platform "$chosen" || err 'Unsupported platform.'
                local previous
                for previous in "${SELECTED_PLATFORMS[@]}"; do [[ $previous != "$REPLY" ]] || err 'Choose distinct platforms.'; done
                SELECTED_PLATFORMS+=("$REPLY")
            done;;
        n|no)
            ask chosen EARNAPP_CLIENT linux
            normalize_platform "$chosen" || err 'Unsupported platform.'
            SELECTED_PLATFORMS=("$REPLY");;
        *) err 'Choose yes or no.';;
    esac
    PLATFORM=${SELECTED_PLATFORMS[0]}
    PLATFORM_LIST=$(IFS=,; printf '%s' "${SELECTED_PLATFORMS[*]}")
    printf 'Rotation: %s\n' "$PLATFORM_LIST"
}

prepare_folder() {
    local previous='' saved_owner='' oldrouter='' oldnet='' archive
    [[ ! -f $DATA/folder.path ]] || previous=$(cat "$DATA/folder.path")
    if [[ -f $DATA/config.tsv ]]; then
        saved_owner=$(awk -F '\t' '$1=="K" && $2=="CONFIG_OWNER" {print $3}' "$DATA/config.tsv")
        if [[ -z $saved_owner ]]; then
            oldrouter=$(awk -F '\t' '$1=="K" && $2=="ROUTER" {print $3}' "$DATA/config.tsv")
            oldnet=$(awk -F '\t' '$1=="K" && $2=="LAN" {print $3}' "$DATA/config.tsv")
            if [[ -n $oldrouter ]] && exists container "$oldrouter"; then
                saved_owner=$(docker inspect -f "{{index .Config.Labels \"$LABEL\"}}" "$oldrouter")
            elif [[ -n $oldnet ]] && exists network "$oldnet"; then
                saved_owner=$(docker network inspect -f "{{index .Labels \"$LABEL\"}}" "$oldnet")
            fi
        fi
        if [[ ( -n $previous && $previous != "$ROOT" ) || ( -n $saved_owner && $saved_owner != "$OWNER" ) ]]; then
            archive="$DATA/copied-settings-$(date +%s)-$$"; mkdir -p "$archive"
            mv -- "$DATA/config.tsv" "$archive/"
            [[ ! -f $ROOT/earnapp.txt ]] || mv -- "$ROOT/earnapp.txt" "$archive/"
            printf '\nCopied folder detected. Old settings archived; this folder gets a separate setup.\n'
        fi
    fi
    printf '%s\n' "$ROOT" > "$DATA/folder.path"
}

# Cache occupied address ranges once per setup.
declare -a USED_LOW=() USED_HIGH=()
remember_subnet() {
    [[ $1 == */* && $1 != *:* && $1 != 0.0.0.0/0 ]] || return 0
    parse_net "$1"; USED_LOW+=("$NETNUM"); USED_HIGH+=("$BROADCAST")
}
collect_used_subnets() {
    USED_LOW=(); USED_HIGH=()
    local ids rows cidr
    ids=$(docker network ls -q)
    if [[ -n $ids ]]; then
        local -a list=(); mapfile -t list <<< "$ids"
        rows=$(docker network inspect -f '{{range .IPAM.Config}}{{println .Subnet}}{{end}}' "${list[@]}")
        while IFS= read -r cidr; do remember_subnet "$cidr"; done <<< "$rows"
    fi
    if command -v ip >/dev/null; then
        rows=$(ip -4 route show table all)
        while IFS= read -r cidr; do remember_subnet "$cidr"; done < <(awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/) {print $i;break}}' <<< "$rows")
    fi
}
free_subnet_default() {
    local block base count n candidate taken i
    for block in 10 172 192; do
        case $block in 10) base=167772160; count=65536;;172) base=2886729728;count=4096;;192) base=3232235520;count=256;;esac
        for ((n=0;n<count;n++)); do
            candidate=$((base+((OWNER+n)%count)*256)); taken=0
            for ((i=0;i<${#USED_LOW[@]};i++)); do
                if ((candidate<=USED_HIGH[i] && candidate+255>=USED_LOW[i])); then taken=1;break;fi
            done
            if ((taken==0)); then REPLY="$(ipstr "$candidate")/24";return 0;fi
        done
    done
    err 'No free private /24 found among host and Docker routes.'
}
unique_prefix() {
    local stem=$1 attempt=0 candidate
    while :; do
        candidate=$stem; ((attempt==0)) || candidate="$stem-$attempt"
        if ! exists network "$candidate-lan" && ! exists network "$candidate-nat" && ! exists container "$candidate-router" && ! exists container "$candidate-1" && ! exists volume "$candidate-1"; then REPLY=$candidate;return 0;fi
        attempt=$((attempt+1))
    done
}
choose_worker_prefix() {
    local proposed i busy candidate
    ask proposed 'Container prefix (xx creates xx-1, xx-2, ...)' "$NAME"
    [[ $proposed =~ ^[a-z][a-z0-9-]{0,24}$ ]] || err 'Prefix: lowercase letters, digits, hyphens; start with a letter.'
    candidate=$proposed
    while :; do
        busy=0
        for ((i=0;i<${#PROXIES[@]};i++)); do
            if exists container "$candidate-$((i+1))" || exists volume "$candidate-$((i+1))"; then busy=1;break;fi
        done
        ((busy)) || break
        candidate="$proposed-$OWNER-${RANDOM}"
    done
    [[ $candidate == "$proposed" ]] || printf 'Prefix already in use; assigned %s to avoid collisions.\n' "$candidate"
    WORKER_PREFIX=$candidate
}

# Builds continue producing the requested :latest tags. Containers use saved
# immutable IDs, so concurrent builds from other folders cannot swap images.
build_router_image() {
    rm -f -- "$DATA/router-image.id"
    docker build --iidfile "$DATA/router-image.id" -t "$ROUTER_IMAGE" "$ROOT/tun2socks-router"
    ROUTER_ID=$(cat "$DATA/router-image.id")
    [[ $ROUTER_ID =~ ^sha256:[0-9a-f]{64}$ ]] || err 'Invalid router image ID.'
    docker tag "$ROUTER_ID" "$NAME-router:instance"
}
AA_READY=0
AA_PROFILE=''
AA_STATUS='Auto-detect before container start'
declare -a AA_OPTIONS=()
apparmor_unix_enabled() {
    local value=''
    [[ ! -r /sys/kernel/security/apparmor/features/network/af_unix ]] || value=$(cat /sys/kernel/security/apparmor/features/network/af_unix)
    [[ $value == yes ]]
}
find_apparmor_parser() {
    if command -v apparmor_parser >/dev/null; then command -v apparmor_parser
    elif [[ -x /usr/sbin/apparmor_parser ]]; then printf '/usr/sbin/apparmor_parser\n';fi
}
aa_privileged() {
    if ((EUID==0)); then "$@";else command -v sudo >/dev/null || err 'Run launcher with sudo for AppArmor installation.';sudo -- "$@";fi
}
aa_abi_available() { [[ -r "/etc/apparmor.d/abi/$1" ]]; }
render_apparmor() {
    local abi=$1
    # New ABI when available, otherwise compile explicit Unix rules using the
    # installed parser's supported policy. No required ABI 4.0 package/version.
    sed -e '/^abi /d' -e "s/docker-tun/$AA_PROFILE/g" "$ROOT/apparmor/docker-tun" > "$DATA/apparmor.body"
    {
        [[ $abi == legacy ]] || printf 'abi <abi/%s>,\n' "$abi"
        cat "$DATA/apparmor.body"
    } > "$DATA/apparmor.profile"
}
ensure_apparmor() {
    [[ $AA_READY != 1 ]] || return 0
    AA_OPTIONS=();AA_PROFILE=''
    local security parser target abi accepted=0
    security=$(docker info -f '{{json .SecurityOptions}}')
    if [[ $security != *apparmor* ]]; then AA_STATUS='Docker AppArmor inactive';AA_READY=1;return 0;fi
    if ! apparmor_unix_enabled; then AA_STATUS='AF_UNIX mediation not detected; Docker default';AA_READY=1;return 0;fi
    parser=$(find_apparmor_parser)
    if [[ -z $parser ]]; then
        command -v apt-get >/dev/null || err 'Install apparmor_parser on the Docker host, then retry.'
        aa_privileged apt-get update
        aa_privileged apt-get install -y --no-install-recommends apparmor
        parser=$(find_apparmor_parser)
    fi
    [[ -n $parser ]] || err 'AppArmor parser unavailable after installation.'
    AA_PROFILE="ea-docker-tun-$OWNER";target="/etc/apparmor.d/$AA_PROFILE"
    [[ -f $ROOT/apparmor/docker-tun ]] || err 'Extract the complete ZIP: apparmor/docker-tun missing.'
    for abi in 4.0 3.0 legacy; do
        if [[ $abi != legacy ]] && ! aa_abi_available "$abi"; then continue;fi
        render_apparmor "$abi"
        if ! aa_privileged "$parser" -Q -T "$DATA/apparmor.profile" > "$DATA/apparmor-validate.log" 2>&1; then continue;fi
        # Validate both the parser and the running kernel before persisting it.
        if ! aa_privileged "$parser" -r -W "$DATA/apparmor.profile" > "$DATA/apparmor-load.log" 2>&1; then continue;fi
        aa_privileged install -d -m 755 /etc/apparmor.d
        aa_privileged install -m 644 "$DATA/apparmor.profile" "$target"
        accepted=1;break
    done
    ((accepted)) || err "No AppArmor profile variant loaded. See $DATA/apparmor-validate.log and apparmor-load.log; no unconfined fallback was applied."
    AA_OPTIONS=(--security-opt "apparmor=$AA_PROFILE")
    AA_STATUS="$AA_PROFILE loaded ($abi / AF_UNIX)";AA_READY=1
    printf 'AppArmor compatible profile selected: %s\n' "$abi"
}
needs_apparmor_recreate() {
    [[ -n $AA_PROFILE ]] || return 1
    [[ $(docker inspect -f '{{.AppArmorProfile}}' "$1") != "$AA_PROFILE" ]]
}
instance_summary() {
    printf '\nFolder: %s\nOwner: %s\n' "$ROOT" "$OWNER"
    [[ -f $DATA/config.tsv ]] || { printf 'No setup yet. Select 1.\n';return 0; }
    load
    printf 'Worker prefix: %s\nRouter: %s\nLAN: %s (%s)\nUplink: %s\nPlatforms: %s\n' "$WORKER_PREFIX" "$ROUTER" "$LAN" "$SUBNET" "$WAN" "$PLATFORM_LIST"
    local i
    for ((i=0;i<${#IPS[@]};i++)); do printf '%-28s %-15s %-10s %s\n' "$(worker_name "$i")" "${IPS[i]}" "$(worker_platform "$i")" "${DESIRED[i]}";done
}

choose_dns_settings() {
    local choice transport provider
    printf '\n  1  DNS leak (default): resolver sees host public IP; direct TCP 53.\n'
    printf '  2  DNS-over-HTTPS: encrypted DNS on TCP 443.\n'
    printf '  3  Direct proxy DNS: DNS through assigned proxy on TCP 53.\n'
    printf 'Only DNS changes; other worker traffic stays on its assigned proxy.\n'
    ask choice 'DNS mode: 1 / 2 / 3' 1
    case "${choice,,}" in
        1|dns-leak)
            DNS_MODE=dns-leak;DNS_PROVIDER=cloudflare
            ask DNS 'Direct DNS resolver IPv4 (host uplink TCP 53)' 1.1.1.1
            ipnum "$DNS" >/dev/null || err 'Invalid DNS IPv4.';;
        2|dns-over-https)
            ask transport 'DNS-over-HTTPS route: proxy / direct' proxy
            case "$transport" in proxy) DNS_MODE=doh-proxy;;direct) DNS_MODE=doh-direct;;*) err 'Choose proxy or direct.';;esac
            ask provider 'DoH provider: cloudflare / google' cloudflare
            case "$provider" in cloudflare|google) DNS_PROVIDER=$provider;;*) err 'Choose cloudflare or google.';;esac
            DNS=1.1.1.1;;
        3|proxy|direct-proxy-dns)
            DNS_MODE=proxy;DNS_PROVIDER=cloudflare
            ask DNS 'DNS resolver IPv4 (proxy must permit TCP port 53)' 1.1.1.1
            ipnum "$DNS" >/dev/null || err 'Invalid DNS IPv4.';;
        *) err 'Choose 1, 2 or 3.';;
    esac
}
apply_dns_settings() {
    choose_dns_settings
    local i name
    # Build first, so a build failure leaves the running deployment untouched.
    build_router_image
    save;write_routes
    for ((i=0;i<${#IPS[@]};i++));do
        name="$(worker_name "$i")";check_owned container "$name"
        if exists container "$name";then docker stop "$name" >/dev/null;fi
    done
    check_owned container "$ROUTER"
    if exists container "$ROUTER";then docker rm -f "$ROUTER" >/dev/null;fi
    router_start
    for ((i=0;i<${#IPS[@]};i++));do [[ ${DESIRED[i]} != running ]] || worker_start "$i";done
    printf 'DNS mode applied: %s / %s\n' "$DNS_MODE" "$DNS_PROVIDER"
}
setup() {
    [[ ! -f $DATA/config.tsv ]] || err 'Setup already exists. Use Resume / repair.'
    exec 8>"/tmp/earnapp-setup-$UID.lock"
    if ! flock -n 8; then printf 'Waiting for another setup to reserve its networks...\n';flock 8;fi
    collect_used_subnets;free_subnet_default;local suggested_subnet=$REPLY
    unique_prefix "ea-$OWNER";local suggested_name=$REPLY
    printf '\n1 Dedicated NAT uplink (new bridge)\n2 Existing Docker NAT uplink (bridge)\nBoth use an isolated worker LAN and ONE router container.\n'
    ask MODE 'NAT mode' 1; [[ $MODE == 1 || $MODE == 2 ]] || err 'Choose 1 or 2.'
    ask NAME 'Instance / network prefix' "$suggested_name"; [[ $NAME =~ ^[a-z][a-z0-9-]{0,24}$ ]] || err 'Invalid network prefix.'
    unique_prefix "$NAME";NAME=$REPLY
    ask SUBNET 'Worker subnet CIDR' "$suggested_subnet"
    parse_net "$SUBNET"; SUBNET=$CANON
    ask NETMASK 'Netmask' "$MASK"
    ask BRIDGE_IP 'Reserved Docker bridge gateway IP' "$(ipstr "$((NETNUM+1))")"
    ask ROUTER_IP 'Router IP / worker default gateway' "$(ipstr "$((NETNUM+2))")"
    ask FIRST_IP 'First worker IP' "$(ipstr "$((NETNUM+10))")"
    ask LAST_IP 'Last worker IP' "$(ipstr "$((BROADCAST-1))")"
    make_pool
    choose_dns_settings
    WAN_SUBNET=-; WAN_GATEWAY=-; WAN=bridge
    if [[ $MODE == 1 ]]; then
        remember_subnet "$SUBNET";free_subnet_default
        ask WAN_SUBNET 'Dedicated NAT uplink subnet' "$REPLY"
        parse_net "$WAN_SUBNET"; WAN_SUBNET=$CANON
        ((PREFIX >= 1 && PREFIX <= 30)) || err "Uplink prefix must be /1 through /30."
        ask WAN_GATEWAY 'Dedicated NAT gateway' "$(ipstr "$((NETNUM+1))")"; valid_host "$WAN_GATEWAY"
        local wn=$NETNUM wb=$BROADCAST
        parse_net "$SUBNET"
        ((NETNUM > wb || BROADCAST < wn)) || err 'Worker and uplink subnets overlap.'
        check_overlap "$WAN_SUBNET"; WAN="$NAME-nat"
    else
        [[ $(docker network inspect -f '{{.Driver}} {{.Internal}}' bridge) == 'bridge false' ]] || err 'Docker default NAT bridge is unavailable.'
    fi
    check_overlap "$SUBNET"
    WORKER_IMAGE=$EARNAPP_IMAGE; WRAPPER_IMAGE=$EARNAPP_IMAGE; BASE_ID=-
    printf '\n  Worker image: %s (built automatically from included files)\n' "$EARNAPP_IMAGE"
    printf '  Platforms: linux, mac, win, ios, tizen, webos\n'
    select_platforms
    ask UDP 'UDP policy: reject (TCP-only proxies) or tunnel (SOCKS5 UDP)' reject
    [[ $UDP == reject || $UDP == tunnel ]] || err 'Choose reject or tunnel.'
    printf 'Paste proxies in order, one per line; blank line finishes.\nIPv4:port:user:password, IPv4:port, socks5:// or http:// URLs.\n'
    printf 'DNS transport: %s (DoH modes use destination TCP 443 only).\n' "$DNS_MODE"
    IPS=(); PROXIES=(); DESIRED=(); LINKS=()
    local line endpoint ep
    parse_net "$SUBNET"
    while IFS= read -r line; do
        line=${line%$'\r'}; [[ -n $line ]] || break
        if ! normalize_proxy "$line"; then printf 'Invalid proxy; paste its replacement. Use a literal IPv4 endpoint.\n'; continue; fi
        [[ $UDP != tunnel || $REPLY != http://* ]] || err 'HTTP proxies require UDP reject mode.'
        endpoint=${REPLY##*@}; endpoint=${endpoint#*://}; endpoint=${endpoint%:*}
        ep=$(ipnum "$endpoint")
        ((ep < NETNUM || ep > BROADCAST)) || err 'Proxy endpoint is inside the worker subnet.'
        PROXIES+=("$REPLY")
    done
    ((${#PROXIES[@]} > 0 && ${#PROXIES[@]} <= ${#POOL[@]} && ${#PROXIES[@]} <= 4096)) || err 'No proxies, insufficient eligible IPs, or more than 4096 proxies.'
    choose_worker_prefix
    WORKER_PLATFORMS=()
    LAN="$NAME-lan"; ROUTER="$NAME-router"; WRAPPER_IMAGE=$EARNAPP_IMAGE
    local i name
    for name in "$LAN" "$([[ $MODE == 1 ]] && printf '%s' "$WAN" || printf '%s' "$LAN")"; do
        ! exists network "$name" || err "Network '$name' exists; choose another prefix."
    done
    ! exists container "$ROUTER" || err "Container '$ROUTER' already exists."
    for ((i=0;i<${#PROXIES[@]};i++)); do
        name="$(worker_name "$i")"; ! exists container "$name" || err "Container '$name' already exists."
        check_owned volume "$name"
        IPS+=("${POOL[i]}"); DESIRED+=(running); LINKS+=(-)
        WORKER_PLATFORMS+=("${SELECTED_PLATFORMS[i % ${#SELECTED_PLATFORMS[@]}]}")
    done
    save
    networks # Atomically reserve subnets before another folder completes setup.
    flock -u 8;exec 8>&-
    build_images
    deploy
    local wait; ask wait 'Seconds to wait for registration links' 300; collect "$wait"
}
build_images() {
    [[ -f $ROOT/tun2socks-router/Dockerfile ]] || err 'Extract the whole ZIP; tun2socks-router/Dockerfile is missing.'
    printf '\nBuilding %s from the included source...\n' "$ROUTER_IMAGE"
    build_router_image
    [[ -f $ROOT/multiplatform-earnapp/Dockerfile ]] || err 'Bundled EarnApp Dockerfile is missing; extract the whole ZIP.'
    printf '\nBuilding %s from included EarnApp files...\n' "$EARNAPP_IMAGE"
    rm -f -- "$DATA/worker-image.id"
    docker build --iidfile "$DATA/worker-image.id" -t "$EARNAPP_IMAGE" "$ROOT/multiplatform-earnapp"
    WORKER_IMAGE=$EARNAPP_IMAGE; WRAPPER_IMAGE=$EARNAPP_IMAGE
    BASE_ID=$(cat "$DATA/worker-image.id")
    [[ $BASE_ID =~ ^sha256:[0-9a-f]{64}$ ]] || err 'Invalid worker image ID.'
    docker tag "$BASE_ID" "$NAME-worker:instance"
    save

}
networks() {
    check_owned network "$LAN"
    if exists network "$LAN"; then
        [[ $(docker network inspect -f '{{.Driver}} {{.Internal}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' "$LAN") == "bridge true $SUBNET" ]] || err 'Managed LAN configuration changed.'
    else
        docker network create --driver bridge --internal --ipv6=false --subnet "$SUBNET" --gateway "$BRIDGE_IP" --label "$LABEL=$OWNER" "$LAN" >/dev/null
    fi
    if [[ $MODE == 1 ]]; then
        check_owned network "$WAN"
        if ! exists network "$WAN"; then
            docker network create --driver bridge --subnet "$WAN_SUBNET" --gateway "$WAN_GATEWAY" --label "$LABEL=$OWNER" "$WAN" >/dev/null
        fi
    fi
}
router_start() {
    ensure_apparmor
    check_owned container "$ROUTER"
    if exists container "$ROUTER" && needs_apparmor_recreate "$ROUTER";then docker rm -f "$ROUTER" >/dev/null;fi
    if ! exists container "$ROUTER"; then
        docker create "${AA_OPTIONS[@]}" --name "$ROUTER" --label "$LABEL=$OWNER" --network "$WAN" \
            --cap-add NET_ADMIN --device /dev/net/tun --sysctl net.ipv4.ip_forward=1 \
            --sysctl net.ipv4.conf.all.rp_filter=0 --sysctl net.ipv4.conf.default.rp_filter=0 \
            --sysctl net.ipv6.conf.all.disable_ipv6=1 --restart unless-stopped \
            --log-opt max-size=5m --log-opt max-file=2 \
            --mount "type=bind,src=$DATA,dst=/config,readonly" \
            -e ROUTES_FILE=/config/routes.conf -e "EA_ROUTER_IP=$ROUTER_IP" \
            -e "DNS_LISTEN=$ROUTER_IP:53" -e "DNS_UPSTREAM=$DNS:53" -e "DNS_MODE=$DNS_MODE" -e "DNS_PROVIDER=$DNS_PROVIDER" \
            -e UNMAPPED_POLICY=block -e "UDP_POLICY=$UDP" "$ROUTER_ID" >/dev/null
    fi
    local attached; attached=$(docker inspect -f '{{range $name,$n := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$ROUTER")
    if ! grep -Fxq "$LAN" <<< "$attached"; then docker network connect --ip "$ROUTER_IP" "$LAN" "$ROUTER"; fi
    docker start "$ROUTER" >/dev/null
    local attempt health
    for ((attempt=0;attempt<45;attempt++)); do
        health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$ROUTER")
        [[ $health == healthy ]] && return 0
        sleep 2
    done
    err 'Router not healthy after 90s; workers were not released. See menu 9 for logs.'
}
worker_start() {
    ensure_apparmor
    local i=$1 name="$(worker_name "$1")" attached
    check_owned container "$name"; check_owned volume "$name"
    if exists container "$name"; then
        attached=$(docker inspect -f '{{range $name,$n := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$name")
        [[ $attached == "$LAN" ]] || err "$name has unexpected network attachments."
        if needs_apparmor_recreate "$name" || [[ $WORKER_IMAGE == "$EARNAPP_IMAGE" && $BASE_ID == sha256:* && $(docker inspect -f '{{.Image}}' "$name") != "$BASE_ID" ]]; then
            docker rm -f "$name" >/dev/null
        fi
    fi
    if ! exists container "$name"; then
        if ! exists volume "$name"; then docker volume create --label "$LABEL=$OWNER" "$name" >/dev/null; fi
        docker create -it "${AA_OPTIONS[@]}" --name "$name" --label "$LABEL=$OWNER" --network "$LAN" \
            --ip "${IPS[i]}" --dns "$ROUTER_IP" --cap-add NET_ADMIN \
            --sysctl net.ipv6.conf.all.disable_ipv6=1 --restart unless-stopped \
            --log-opt max-size=1m --log-opt max-file=1 \
            -e "EARNAPP_CLIENT=$(worker_platform "$i")" -e "EA_ROUTER_IP=$ROUTER_IP" \
            --mount "type=volume,src=$name,dst=/data" \
            --mount "type=bind,src=$DATA/resolv.conf,dst=/etc/resolv.conf,readonly" \
            "$BASE_ID" >/dev/null
    fi
    docker start "$name" >/dev/null
    printf '%s: %s -> proxy #%d\n' "$name" "${IPS[i]}" "$((i+1))"
}
deploy() {
    if [[ $WORKER_IMAGE != "$EARNAPP_IMAGE" || $WRAPPER_IMAGE != "$EARNAPP_IMAGE" ]]; then
        rebuild_deployment
        return
    fi
    write_routes
    if ! exists image "$ROUTER_ID" || ! exists image "$BASE_ID"; then build_images; fi
    networks; router_start
    local i
    for ((i=0;i<${#IPS[@]};i++)); do [[ ${DESIRED[i]} != running ]] || worker_start "$i"; done
}
rebuild_deployment() {
    local i name
    printf '\n  Rebuilding bundled images and applying them; worker data volumes are retained.\n'
    for ((i=0;i<${#IPS[@]};i++)); do
        name="$(worker_name "$i")"; check_owned container "$name"
        if exists container "$name"; then docker stop "$name" >/dev/null; fi
    done
    build_images
    for ((i=0;i<${#IPS[@]};i++)); do
        name="$(worker_name "$i")"
        if exists container "$name"; then docker rm "$name" >/dev/null; fi
    done
    check_owned container "$ROUTER"
    if exists container "$ROUTER"; then docker rm -f "$ROUTER" >/dev/null; fi
    deploy
}
select_worker() {
    local number
    ask number 'Container number' 1
    [[ $number =~ ^[0-9]{1,5}$ ]] || err 'Invalid number.'
    SELECTED=$((10#$number-1)); ((SELECTED>=0 && SELECTED<${#IPS[@]})) || err 'No such worker.'
}
worker_stop() {
    local i=$1 name="$(worker_name "$1")"
    DESIRED[i]=stopped; save; check_owned container "$name"
    if exists container "$name"; then docker stop "$name" >/dev/null; fi
}
status() {
    local i name state endpoint
    printf '\n%-28s %-17s %-10s %-12s %s\n' NAME IP PLATFORM STATE 'PROXY (credentials hidden)'
    for ((i=0;i<${#IPS[@]};i++)); do
        name="$(worker_name "$i")"; check_owned container "$name"; state=missing
        if exists container "$name"; then state=$(docker inspect -f '{{.State.Status}}' "$name"); fi
        endpoint=${PROXIES[i]##*@}; endpoint=${endpoint#*://}
        printf '%-28s %-17s %-10s %-12s %s\n' "$name" "${IPS[i]}" "$(worker_platform "$i")" "$state" "$endpoint"
    done
    check_owned container "$ROUTER"
    if exists container "$ROUTER"; then docker inspect -f 'Router: {{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$ROUTER"; fi
}
change_proxy() {
    select_worker
    local new i name
    ask new 'Replacement proxy'
    normalize_proxy "$new" || err 'Invalid proxy.'
    [[ $UDP != tunnel || $REPLY != http://* ]] || err 'HTTP proxies require UDP reject mode.'
    new=$REPLY
    local endpoint=${new##*@} ep
    endpoint=${endpoint#*://}; endpoint=${endpoint%:*}
    ep=$(ipnum "$endpoint"); parse_net "$SUBNET"
    ((ep < NETNUM || ep > BROADCAST)) || err 'Proxy endpoint is inside the worker subnet.'
    printf 'Pausing running managed workers while router connections are reset...\n'
    for ((i=0;i<${#IPS[@]};i++)); do
        name="$(worker_name "$i")"; check_owned container "$name"
        if exists container "$name"; then docker stop "$name" >/dev/null; fi
    done
    PROXIES[SELECTED]=$new; save; write_routes
    check_owned container "$ROUTER"
    if exists container "$ROUTER"; then docker rm -f "$ROUTER" >/dev/null; fi
    router_start
    for ((i=0;i<${#IPS[@]};i++)); do [[ ${DESIRED[i]} != running ]] || worker_start "$i"; done
}
extract_link() {
    # Full nonempty identifier only; reject bare /r/ and obvious truncated prefixes.
    local regex='https://earnapp\.com/r/([A-Za-z0-9][A-Za-z0-9_-]{5,127})($|[[:space:]"<>])'
    if [[ $1 =~ $regex ]]; then printf 'https://earnapp.com/r/%s' "${BASH_REMATCH[1]}"; fi
}
collect() {
    local wait=$1 i name content link missing deadline
    [[ $wait =~ ^[0-9]{1,5}$ ]] || err 'Wait must be 0..86400 seconds.'
    wait=$((10#$wait)); ((wait <= 86400)) || err 'Wait exceeds 86400 seconds.'
    deadline=$((SECONDS+wait))
    while :; do
        missing=0
        for ((i=0;i<${#IPS[@]};i++)); do
            name="$(worker_name "$i")"; check_owned container "$name"
            if exists container "$name" && [[ $(docker inspect -f '{{.State.Running}}' "$name") == true ]]; then
                content=$(timeout 8 docker exec "$name" /ea/busybox cat /data/earnapp.txt 2>/dev/null || true)
                link=$(extract_link "$content")
                [[ -z $link ]] || LINKS[i]=$link
            fi
            [[ ${LINKS[i]} != - ]] || missing=$((missing+1))
        done
        {
            for ((i=0;i<${#IPS[@]};i++)); do
                if [[ ${LINKS[i]} == - ]]; then printf '\n'; else printf '%s\n' "${LINKS[i]}"; fi
            done
        } > "$ROOT/earnapp.txt.tmp"
        mv -f -- "$ROOT/earnapp.txt.tmp" "$ROOT/earnapp.txt"; save
        printf 'Links %d/%d saved. Pending workers keep blank lines so line N = worker N in this folder.\n' "$((${#IPS[@]}-missing))" "${#IPS[@]}"
        ((missing > 0 && SECONDS < deadline)) || break
        sleep 5
    done
}
remove_deployment() {
    local confirm i name
    ask confirm 'Type REMOVE to remove managed containers/networks and keep data volumes'
    [[ $confirm == REMOVE ]] || return 0
    for ((i=0;i<${#IPS[@]};i++)); do
        name="$(worker_name "$i")"; check_owned container "$name"
        if exists container "$name"; then docker rm -f "$name" >/dev/null; fi
    done
    check_owned container "$ROUTER"
    if exists container "$ROUTER"; then docker rm -f "$ROUTER" >/dev/null; fi
    check_owned network "$LAN"
    if exists network "$LAN"; then docker network rm "$LAN" >/dev/null; fi
    if [[ $MODE == 1 ]]; then
        check_owned network "$WAN"
        if exists network "$WAN"; then docker network rm "$WAN" >/dev/null; fi
    fi
    rm -f -- "$DATA/config.tsv" "$DATA/routes.conf"
    printf 'Removed. Identity volumes and earnapp.txt retained.\n'
}
docker_endpoint() {
    local selected context='' endpoint
    # Context overrides DOCKER_HOST, matching Docker CLI precedence.
    if [[ -n ${DOCKER_CONTEXT:-} ]]; then
        docker context inspect -f '{{.Endpoints.docker.Host}}' "$DOCKER_CONTEXT"
        return
    fi
    if [[ -n ${DOCKER_HOST:-} ]]; then
        printf '%s\n' "$DOCKER_HOST"
        return
    fi
    # Older CLIs have context ls/inspect but no context show.
    if selected=$(docker context ls --format '{{if .Current}}{{.Name}}{{end}}' 2>/dev/null); then
        while IFS= read -r selected; do
            [[ -z $selected ]] && continue
            [[ -z $context ]] || err 'Docker reports multiple active contexts.'
            context=$selected
        done <<< "$selected"
        if [[ -n $context ]]; then
            docker context inspect -f '{{.Endpoints.docker.Host}}' "$context"
            return
        fi
    fi
    # Some older formatting implementations omit Current; inspect defaults
    # to the active context. Never silently switch a remote context to local.
    if endpoint=$(docker context inspect -f '{{.Endpoints.docker.Host}}' 2>/dev/null) && [[ -n $endpoint ]]; then
        printf '%s\n' "$endpoint"
        return
    fi
    err 'Cannot resolve the Docker endpoint. For a local engine, run with DOCKER_HOST=unix:///var/run/docker.sock.'
}
prerequisites() {
    ((BASH_VERSINFO[0]>4 || (BASH_VERSINFO[0]==4 && BASH_VERSINFO[1]>=3))) || err 'Bash 4.3 or newer required.'
    local cmd engine endpoint
    for cmd in docker flock timeout cksum awk grep chmod cp mv; do command -v "$cmd" >/dev/null || err "Install required command: $cmd"; done
    engine=$(docker info -f '{{.OSType}}'); [[ $engine == linux ]] || err 'Use a Linux-container Docker engine.'
    [[ $(docker info -f '{{json .SecurityOptions}}') != *rootless* ]] || err 'Rootful Docker is required.'
    endpoint=$(docker_endpoint)
    [[ $endpoint == unix://* ]] || err 'Use a local Unix-socket Docker engine; remote bind mounts are unsupported.'
    [[ $ROOT != *,* && $ROOT != *$'\n'* ]] || err 'Extract to a folder without commas or newlines.'
}
# ANSI colors only for terminals; NO_COLOR disables them for logs/accessibility.
RESET='' CYAN='' BLUE='' GREEN='' YELLOW='' RED='' DIM='' BOLD=''
ui_init() {
    if [[ -t 1 && ${TERM:-dumb} != dumb && -z ${NO_COLOR+x} ]]; then
        RESET=$'\e[0m'; CYAN=$'\e[36m'; BLUE=$'\e[34m'; GREEN=$'\e[32m'
        YELLOW=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[2m'; BOLD=$'\e[1m'
    fi
}
show_art() {
    local art="$ROOT/assets/ascii-art-compact.txt" line
    [[ ${1:-compact} != full ]] || art="$ROOT/assets/ascii-art.txt"
    [[ -f $art ]] || return 0
    printf '\n%s' "$CYAN"
    while IFS= read -r line; do printf '  %s\n' "$line"; done < "$art"
    printf '%s\n' "$RESET"
}
draw_menu() {
    local total=0 active=0 linked=0 router_state='NOT CONFIGURED' line
    if [[ -f $DATA/config.tsv ]]; then
        load
        total=${#IPS[@]}
        local i name summary
        # One Docker query for all actual running managed workers.
        summary=$(docker ps --filter "label=$LABEL=$OWNER" --format '{{.Names}}' 2>/dev/null || true)
        while IFS= read -r name; do [[ $name != "$WORKER_PREFIX-"* || $name == "$ROUTER" ]] || active=$((active+1)); done <<< "$summary"
        for ((i=0;i<total;i++)); do [[ ${LINKS[i]} == - ]] || linked=$((linked+1)); done
        router_state=$(docker inspect -f '{{.State.Status}}{{if .State.Health}} / {{.State.Health.Status}}{{end}}' "$ROUTER" 2>/dev/null || printf 'not created')
    fi
    printf '\n%s  ============================================================%s\n' "$CYAN" "$RESET"
    printf '%s     E A R N A P P   /   C O N T R O L   C E N T E R%s\n' "$BOLD" "$RESET"
    printf '%s          FOLDER EDITION | MULTI-PLATFORM | AUTO APPARMOR%s\n' "$DIM" "$RESET"
    printf '%s  ============================================================%s\n' "$CYAN" "$RESET"
    printf '    WORKERS  %s%-6s%s  RUNNING  %s%-6s%s  LINKS  %s%s/%s%s\n' "$BOLD" "$total" "$RESET" "$GREEN" "$active" "$RESET" "$CYAN" "$linked" "$total" "$RESET"
    printf '    FOLDER   %s\n' "$ROOT"
    printf '    APPARMOR Auto-detect on deployment (option 17)\n'
    printf '    ROUTER   %s\n' "$router_state"
    if [[ -f $DATA/config.tsv ]]; then printf '    PREFIX   %s  |  PLATFORMS  %s\n' "$WORKER_PREFIX" "$PLATFORM_LIST"; printf '    DNS      %s / %s\n' "$DNS_MODE" "$DNS_PROVIDER"; fi
    printf '%s  ------------------------------------------------------------%s\n' "$DIM" "$RESET"
    printf '%s    DEPLOY & MONITOR%s\n' "$CYAN" "$RESET"
    printf '     1  New setup                 2  Worker status\n'
    printf '     3  Resume / repair          13  Start all workers\n'
    printf '%s    WORKERS & ROUTING%s\n' "$CYAN" "$RESET"
    printf '     4  Stop one worker           5  Start one worker\n'
    printf '     6  Change one proxy          7  Collect registration links\n'
    printf '     8  Stop all workers         11  Test public IP\n'
    printf '%s    TOOLS & MAINTENANCE%s\n' "$CYAN" "$RESET"
    printf '     9  Router logs              10  Worker logs\n'
    printf '    14  Rebuild & apply images    15  Show full mascot art\n'
    printf '    16  DNS settings: DNS leak / HTTPS / proxy DNS\n'
    printf '    17  AppArmor: detect / install / apply\n'
    printf '    18  This folder: names, networks & platform assignments\n'
    printf '    12  Remove deployment (keep volumes)\n'
    printf '%s  ------------------------------------------------------------%s\n' "$DIM" "$RESET"
    printf '     0  Exit\n'
    printf '%s    Auto-build: multiplatform-earnapp:latest\n' "$DIM"
    printf '                tun2socks-router:latest%s\n\n' "$RESET"
}
main() {
    if [[ ${1:-} == --help ]]; then cat "$ROOT/README.txt"; return 0; fi
    umask 077; mkdir -p "$DATA"
    command -v flock >/dev/null || err 'Install util-linux (flock).'
    exec 9>"$DATA/manager.lock"; flock -n 9 || err 'Another launcher is running.'
    prerequisites
    prepare_folder
    ui_init
    show_art compact
    local choice result i wait
    while :; do
        draw_menu
        local default_choice=1
        [[ ! -f $DATA/config.tsv ]] || default_choice=2
        ask choice 'Choose an action' "$default_choice"
        [[ $choice != 0 ]] || return 0
        # Keep errexit active INSIDE each action. Failure returns to the menu;
        # do not wrap actions in 'if function', which disables Bash errexit.
        set +e
        (
            set -Eeuo pipefail
            trap 'printf "Action failed; saved configuration can be resumed from menu 3.\n" >&2' ERR
            if [[ $choice == 15 ]]; then show_art full
            elif [[ $choice == 17 ]]; then ensure_apparmor; printf 'AppArmor: %s\n' "$AA_STATUS"; if [[ -f $DATA/config.tsv ]];then load;deploy;fi
            elif [[ $choice == 18 ]]; then instance_summary
            elif [[ $choice == 1 ]]; then setup
            else
                load
                case "$choice" in
                    2) status;;
                    3) deploy;;
                    4) select_worker; worker_stop "$SELECTED";;
                    5) select_worker; DESIRED[SELECTED]=running; save; router_start; worker_start "$SELECTED";;
                    6) change_proxy;;
                    7) ask wait 'Maximum wait seconds' 300; collect "$wait";;
                    8) for ((i=0;i<${#IPS[@]};i++)); do worker_stop "$i"; done
                       check_owned container "$ROUTER"; if exists container "$ROUTER"; then docker stop "$ROUTER"; fi;;
                    9) check_owned container "$ROUTER"; docker logs --tail 80 "$ROUTER";;
                    10) select_worker; check_owned container "$(worker_name "$SELECTED")"; docker logs --tail 80 "$(worker_name "$SELECTED")";;
                    11) select_worker; check_owned container "$(worker_name "$SELECTED")"
                        docker exec "$(worker_name "$SELECTED")" /ea/busybox ip route
                        docker exec "$(worker_name "$SELECTED")" /ea/busybox cat /etc/resolv.conf
                        docker exec "$(worker_name "$SELECTED")" /ea/busybox wget -qO- -T 20 http://api.ipify.org; printf '\n';;
                    12) remove_deployment;;
                    13) for ((i=0;i<${#IPS[@]};i++)); do DESIRED[i]=running; done; save; deploy;;
                    14) rebuild_deployment;;
                    16) apply_dns_settings;;
                    15) show_art full;;
                    *) printf 'Unknown selection.\n';;
                esac
            fi
        )
        result=$?
        set -e
        if ((result != 0)); then printf '%s  Action ended with status %d.%s\n' "$RED" "$result" "$RESET"; fi
        if [[ -t 0 ]]; then printf '\n  Press Enter to return to the dashboard...'; IFS= read -r _ || return 0; fi
    done
}
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
