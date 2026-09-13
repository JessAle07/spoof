#!/usr/bin/env bash
set -Eeuo pipefail
TEST_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$TEST_ROOT/earnapp-launcher.sh"
TEMP=$(mktemp -d)
trap 'rm -rf -- "$TEMP"' EXIT
DATA="$TEMP/data"; mkdir -p "$DATA"; ROOT=$TEMP
passed=0
ok() { passed=$((passed+1)); printf 'PASS %s\n' "$1"; }
[[ $(ipnum 255.255.255.255) == 4294967295 && $(ipstr 4294967295) == 255.255.255.255 ]]
! ipnum 256.1.1.1 >/dev/null; ok 'IPv4 unsigned boundary and invalid octet'
parse_net 10.0.0.5/32; [[ $NETNUM == "$BROADCAST" ]]; ok 'Host /32 overlap parsing'
SUBNET=192.168.0.0/22 NETMASK=255.255.252.0 BRIDGE_IP=192.168.2.1 ROUTER_IP=192.168.2.2 FIRST_IP=192.168.1.253 LAST_IP=192.168.3.3
make_pool
[[ ${POOL[0]} == 192.168.1.253 && ${POOL[1]} == 192.168.1.254 && ${POOL[2]} == 192.168.2.3 ]]
[[ ${POOL[${#POOL[@]}-1]} == 192.168.3.3 ]]
for item in "${POOL[@]}"; do [[ $item != *.0 && $item != *.1 && $item != *.255 ]]; done
ok 'IP allocation skips octet/reserved addresses across /24 boundaries'
if (NETMASK=255.255.0.0; make_pool) 2>/dev/null; then exit 1; fi
ok 'Mismatched netmask refused'
normalize_proxy '1.2.3.4:1080:a@b:p:a#?'
[[ $REPLY == 'socks5://a%40b:p%3Aa%23%3F@1.2.3.4:1080' ]]
ok 'Proxy credential URL encoding'
for item in '1.2.3.4:65536' 'https://1.2.3.4:80' 'socks5://domain.test:80' '1.2.3.4:0'; do
    if normalize_proxy "$item"; then exit 1; fi
done
ok 'Invalid/unsupported proxies refused'
[[ -z $(extract_link 'https://earnapp.com/r/') ]]
[[ $(extract_link 'https://earnapp.com/r/sdk-node-abcdef') == https://earnapp.com/r/sdk-node-abcdef ]]
ok 'Only full registration links accepted'
NAME=ea MODE=2 DNS=1.1.1.1 WAN_SUBNET=- WAN_GATEWAY=- LAN=ea-lan WAN=bridge ROUTER=ea-router WORKER_IMAGE=custom:test BASE_ID=sha256:test WRAPPER_IMAGE=ea-worker:local PLATFORM=linux UDP=reject
IPS=(192.168.2.3 192.168.2.4); PROXIES=('socks5://1.2.3.4:1080' 'http://5.6.7.8:8080'); DESIRED=(running stopped); LINKS=(- https://earnapp.com/r/sdk-node-abcdef)
save; IPS=(); load
[[ ${IPS[1]} == 192.168.2.4 && ${DESIRED[1]} == stopped && $WORKER_IMAGE == custom:test ]]
ok 'Bash state roundtrip including stopped worker and saved image'
write_routes
[[ $(wc -l < "$DATA/routes.conf") == 2 ]]
grep -q '^nameserver 192.168.2.2$' "$DATA/resolv.conf"
ok 'Ordered routes and pinned resolver'
# Mock Docker only for command orchestration; no actual containers created.
MOCK_LOG="$TEMP/docker.log"
docker() {
    printf '%s\n' "$*" >> "$MOCK_LOG"
    case "$1 $2" in
        'container inspect'|'volume inspect') return 1;;
        'inspect -f')
            case "$3" in *Health*) printf 'healthy\n';; *) printf 'bridge\n';; esac;;
    esac
}
router_start
connect=$(grep -n '^network connect' "$MOCK_LOG" | cut -d: -f1)
start=$(grep -n '^start ea-router' "$MOCK_LOG" | cut -d: -f1)
((connect<start)); grep -q 'tun2socks-router:latest' "$MOCK_LOG"
ok 'Router exact image tag and LAN attachment before start'
worker_start 0
grep -q 'EARNAPP_CLIENT=linux' "$MOCK_LOG"
grep -q 'type=volume,src=ea-1,dst=/data' "$MOCK_LOG"
grep -q 'sha256:test' "$MOCK_LOG"
ok 'Worker Docker options use configured wrapper and persistent data'
# Collection retains cached link with a blank first line for missing ea-1.
collect 0
[[ $(wc -l < "$ROOT/earnapp.txt") == 2 ]]
[[ -z $(head -n 1 "$ROOT/earnapp.txt") ]]
[[ $(tail -n 1 "$ROOT/earnapp.txt") == https://earnapp.com/r/sdk-node-abcdef ]]
ok 'Link export preserves blank positions and cached links'
# Simulate the reported old CLI: context show is absent, ls/inspect work.
unset DOCKER_HOST DOCKER_CONTEXT
MOCK_MODE=old
docker() {
    case "$1 $2" in
        'context show') printf 'unsupported show\n' >&2; return 1;;
        'context ls')
            [[ $MOCK_MODE != fallback ]] || return 1
            printf '\ndefault\n\n';;
        'context inspect')
            if [[ ${5:-} == remote ]]; then printf 'ssh://remote-host\n'
            else printf 'unix:///var/run/docker.sock\n'; fi;;
        *) return 1;;
    esac
}
[[ $(docker_endpoint) == unix:///var/run/docker.sock ]]
ok 'Old Docker without context show resolves active context'
MOCK_MODE=fallback
[[ $(docker_endpoint) == unix:///var/run/docker.sock ]]
ok 'Context inspect fallback when listing format is unsupported'
DOCKER_HOST=unix:///custom/docker.sock
[[ $(docker_endpoint) == unix:///custom/docker.sock ]]
ok 'Explicit DOCKER_HOST honored'
DOCKER_CONTEXT=remote
[[ $(docker_endpoint) == ssh://remote-host ]]
ok 'DOCKER_CONTEXT takes precedence; remote endpoint is not disguised as local'
unset DOCKER_CONTEXT DOCKER_HOST
# Included source builds under the exact requested tags, without prompting.
ROOT=$TEST_ROOT
BUILD_LOG="$TEMP/build.log"
docker() {
    printf '%s\n' "$*" >> "$BUILD_LOG"
    if [[ $1 == build && $2 == --iidfile ]]; then printf 'sha256:%064d\n' 1 > "$3"; fi
    if [[ $1 == image && $2 == inspect ]]; then printf 'sha256:bundled\n'; fi
}
build_images
[[ $WORKER_IMAGE == multiplatform-earnapp:latest && $WRAPPER_IMAGE == multiplatform-earnapp:latest ]]
grep -q -- '-t multiplatform-earnapp:latest ' "$BUILD_LOG"
grep -q -- '-t tun2socks-router:latest ' "$BUILD_LOG"
ok 'Bundled sources build both exact image tags without an image-name prompt'
# Dashboard smoke check, with no ANSI codes in captured/nonterminal output.
ui_init
draw_menu > "$TEMP/menu.txt"
grep -q 'C O N T R O L' "$TEMP/menu.txt"
grep -q 'multiplatform-earnapp:latest' "$TEMP/menu.txt"
! grep -q $'\e' "$TEMP/menu.txt"
show_art compact > "$TEMP/art.txt"
[[ -s $TEMP/art.txt ]]
ok 'Dashboard and supplied mascot render without ANSI escapes in plain output'
printf '%d tests passed. Docker calls above were mocked.\n' "$passed"
