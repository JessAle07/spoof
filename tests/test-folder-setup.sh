#!/usr/bin/env bash
# Runs the REAL setup, save/load, deploy and dashboard code against a fake Docker
# daemon. No host networking, AppArmor installation or Docker containers touched.
set -Eeuo pipefail
PACKAGE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$PACKAGE/earnapp-launcher.sh"
T=$(mktemp -d);trap 'rm -rf "$T"' EXIT
MOCK="$T/daemon";mkdir -p "$MOCK/net" "$MOCK/container" "$MOCK/volume"
LOG="$T/commands";PROMPTS="$T/prompts"
ip() { return 0; }
docker() {
    printf '%s\n' "$*" >> "$LOG"
    local kind=${1:-} action=${2:-} name='' template='' arg subnet='' internal=false network='' platform='' owner=$OWNER prev=''
    if [[ $kind == info ]];then printf '%s\n' "${MOCK_SECURITY:-[]}";return;fi
    if [[ $kind == image ]];then printf 'sha256:test\n';return;fi
    if [[ $kind == inspect ]];then
        template=$3;name=$4
        [[ -f $MOCK/container/$name ]] || return 1
        case "$template" in
            *AppArmorProfile*) printf 'docker-default\n';;
            *Labels*) cut -f1 "$MOCK/container/$name";;
            *Health*) printf healthy;;
            *Networks*) printf '%s\n' "$LAN";;
            *Image*) printf '%s\n' "$BASE_ID";;
            *Status*) printf running;;
            *Running*) printf true;;
        esac
        return 0
    fi
    if [[ $action == inspect ]];then
        shift 2
        if [[ ${1:-} == -f ]];then template=$2;shift 2;fi
        for name in "$@";do
            [[ -f $MOCK/${kind/network/net}/$name ]] || return 1
            case "$template" in
                *Labels*) cut -f1 "$MOCK/${kind/network/net}/$name";;
                *Driver*) printf 'bridge true %s\n' "$(cut -f2 "$MOCK/net/$name")";;
                *Subnet*) cut -f2 "$MOCK/net/$name";;
            esac
        done
        return 0
    fi
    if [[ $kind == network && $action == ls ]];then
        for name in "$MOCK/net/"*;do [[ ! -f $name ]] || basename "$name";done
        return 0
    fi
    if [[ $kind == network && $action == create ]];then
        for arg in "$@";do [[ $prev != --subnet ]] || subnet=$arg;prev=$arg;name=$arg;done
        printf '%s\t%s\n' "$OWNER" "$subnet" > "$MOCK/net/$name";return
    fi
    if [[ $kind == network && $action == connect ]];then return 0;fi
    if [[ $kind == volume && $action == create ]];then name=${@: -1};printf '%s\n' "$OWNER" > "$MOCK/volume/$name";return;fi
    if [[ $kind == create ]];then
        for arg in "$@";do
            [[ $prev != --name ]] || name=$arg
            [[ $prev != --network ]] || network=$arg
            [[ $arg != EARNAPP_CLIENT=* ]] || platform=${arg#*=}
            prev=$arg
        done
        [[ -n $name && ! -e $MOCK/container/$name ]] || return 1
        printf '%s\t%s\t%s\n' "$OWNER" "$network" "$platform" > "$MOCK/container/$name";return
    fi
    if [[ $kind == rm ]];then rm -f -- "$MOCK/container/${@: -1}";return;fi
    if [[ $kind == start || $kind == stop || $kind == tag ]];then return 0;fi
    if [[ $kind == ps ]];then
        for name in "$MOCK/container/"*;do [[ ! -f $name ]] || { [[ $(cut -f1 "$name") != "$OWNER" ]] || basename "$name"; };done
        return 0
    fi
    printf 'Unhandled mock command\n' >&2;return 1
}
# Fake builds preserve the real setup/deployment path and avoid registry access.
build_images() { BASE_ID=sha256:test;ROUTER_ID=sha256:router;save; }
collect() { return 0; }
ask() {
    printf '%s\n' "$2" >> "$PROMPTS"
    local value=${3:-}
    case "$2" in
        'Use multiple platforms?'*) value=yes;;
        'How many platforms?'*) value=2;;
        'Platform 1') value=tizen;;
        'Platform 2') value=windows;;
        'Container prefix'*) value=node;;
    esac
    printf -v "$1" '%s' "$value"
}
for folder in one two;do
    ROOT="$T/$folder";DATA="$ROOT/ea-launcher-data";mkdir -p "$DATA"
    OWNER=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
    prepare_folder
    setup <<'PROXIES'
1.2.3.4:1080
1.2.3.5:1080
1.2.3.6:1080
1.2.3.7:1080
1.2.3.8:1080

PROXIES
    load
    [[ ${WORKER_PLATFORMS[*]} == 'tizen win tizen win tizen' ]]
    for ((i=0;i<5;i++));do [[ $(cut -f3 "$MOCK/container/$(worker_name "$i")") == "$(worker_platform "$i")" ]];done
    if [[ $folder == one ]];then FIRST_PREFIX=$WORKER_PREFIX;FIRST_LAN=$LAN;FIRST_SUBNET=$SUBNET;FIRST_ROUTER=$ROUTER
    else [[ $WORKER_PREFIX != "$FIRST_PREFIX" && $LAN != "$FIRST_LAN" && $SUBNET != "$FIRST_SUBNET" && $ROUTER != "$FIRST_ROUTER" ]];fi
    draw_menu > "$T/menu-$folder"
    [[ $DNS_MODE == dns-leak && $DNS_PROVIDER == cloudflare ]]
    grep -q '16  DNS settings' "$T/menu-$folder"
    grep -q '17  AppArmor' "$T/menu-$folder"
    grep -q '18  This folder' "$T/menu-$folder"
done
# Stop a worker in folder 2: no folder-1 name may be targeted.
: > "$LOG";worker_stop 0
grep -q "^stop $WORKER_PREFIX-1$" "$LOG"
! grep -q "^stop $FIRST_PREFIX-1$" "$LOG"
# Exercise the actual dashboard option 17 and real AppArmor integration, while
# replacing only host parser/install commands (never writes /etc).
ROOT="$T/two";DATA="$ROOT/ea-launcher-data"
OWNER=$(printf '%s' "$ROOT" | cksum | awk '{print $1}')
mkdir -p "$ROOT/apparmor"
cp "$PACKAGE/apparmor/docker-tun" "$ROOT/apparmor/docker-tun"
MOCK_SECURITY='["name=apparmor"]'
apparmor_unix_enabled() { return 0; }
find_apparmor_parser() { printf '/mock/apparmor_parser\n'; }
aa_abi_available() { return 0; }
aa_privileged() { printf '%s\n' "$*" >> "$T/aa-commands"; }
prerequisites() { return 0; }
MENU_COUNT=0
ask() {
    [[ $2 == 'Choose an action' ]] || { printf 'Unexpected dashboard prompt\n' >&2;return 1; }
    MENU_COUNT=$((MENU_COUNT+1))
    if ((MENU_COUNT==1));then printf -v "$1" 17;else printf -v "$1" 0;fi
}
AA_READY=0
main > "$T/main-output"
grep -q '17  AppArmor' "$T/main-output"
grep -q -- '-Q -T' "$T/aa-commands"
grep -q -- '-r -W ' "$T/aa-commands"
grep -q 'abi <abi/4.0>,' "$DATA/apparmor.profile"
grep -q 'peer=runc,' "$DATA/apparmor.profile"
grep -q -- "--security-opt apparmor=ea-docker-tun-$OWNER" "$LOG"
# Manually stopped worker remains stopped during profile application.
[[ $(awk -F '\t' '$1=="W" && $2==0 {print $5}' "$DATA/config.tsv") == stopped ]]
printf 'PASS: actual dashboard option 17 dispatches parser validation/install and applies profile flags without resuming a stopped worker.\n'
# Legacy/copy configuration is archived, not attached to the original resources.
cp -r "$T/one" "$T/copied"
ROOT="$T/copied";DATA="$ROOT/ea-launcher-data";OWNER=987654
prepare_folder
[[ ! -f $DATA/config.tsv && -f $T/one/ea-launcher-data/config.tsv ]]
grep -q 'Container prefix' "$PROMPTS"
grep -q 'Use multiple platforms' "$PROMPTS"
printf 'PASS: real setup twice, unique networks/names/volumes, platform rotation, dashboard options, stop isolation and cloned-folder detection.\n'
