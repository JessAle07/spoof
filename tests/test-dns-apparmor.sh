#!/usr/bin/env bash
set -Eeuo pipefail
P=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$P/earnapp-launcher.sh"
T=$(mktemp -d);trap 'rm -rf "$T"' EXIT
DATA="$T/data";mkdir -p "$DATA";ROOT=$P
# Execute the real compatibility selection against old parser/ABI combinations.
docker() { printf '["name=apparmor"]\n'; }
apparmor_unix_enabled() { return 0; }
find_apparmor_parser() { printf /mock/parser; }
case_mode=legacy
aa_abi_available() { [[ $case_mode != legacy ]]; }
aa_privileged() {
    if [[ $1 == /mock/parser ]];then
        if [[ $case_mode == legacy ]] && grep -q '^abi ' "$DATA/apparmor.profile";then return 1;fi
        if [[ $case_mode == fallback ]] && grep -q '^abi <abi/4.0>' "$DATA/apparmor.profile";then return 1;fi
    fi
    return 0
}
ensure_apparmor
[[ $AA_STATUS == *legacy* ]]
! grep -q '^abi ' "$DATA/apparmor.profile"
grep -q '^  unix,' "$DATA/apparmor.profile"
grep -q 'peer=runc,' "$DATA/apparmor.profile"
case_mode=fallback;AA_READY=0;ensure_apparmor
[[ $AA_STATUS == *3.0* ]]
printf 'PASS: absent ABI files use legacy profile; rejected ABI 4.0 falls back to ABI 3.0.\n'
# Exercise all three choices and the optional direct DoH route.
selection=1;test_transport=proxy
ask() {
    local value=${3:-}
    case "$2" in
        'DNS mode: 1 / 2 / 3') value=$selection;;
        'DNS-over-HTTPS route: proxy / direct') value=$test_transport;;
    esac
    printf -v "$1" '%s' "$value"
}
choose_dns_settings
[[ $DNS_MODE == dns-leak && $DNS == 1.1.1.1 ]]
selection=2;choose_dns_settings
[[ $DNS_MODE == doh-proxy ]]
test_transport=direct;choose_dns_settings
[[ $DNS_MODE == doh-direct ]]
selection=3;choose_dns_settings
[[ $DNS_MODE == proxy ]]
printf 'PASS: DNS leak default, proxied/direct DoH and proxy DNS selections.\n'
