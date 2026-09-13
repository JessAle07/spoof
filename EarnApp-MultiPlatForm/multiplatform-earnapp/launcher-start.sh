#!/ea/busybox sh
set -eu
# Standalone image commands also work when no managed router is configured.
if [ -n "${EA_ROUTER_IP:-}" ]; then
    /ea/busybox ip route replace default via "$EA_ROUTER_IP"
fi
exec "$@"
