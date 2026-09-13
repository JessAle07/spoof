#!/bin/sh
set -eu
[ -f /run/ea-ready ]
[ -s /run/ea-pids ]
for p in $(cat /run/ea-pids); do kill -0 "$p" || exit 1; done
