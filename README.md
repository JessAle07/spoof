 LAUNCHER — DNS 443 / COMPATIBLE APPARMOR EDITION
================================================
This package has dashboard options 16, 17 and 18. If you do not see them, you are
running another copy of earnapp-launcher.sh. The dashboard prints its folder.

QUICK START
Extract the COMPLETE ZIP. From that extracted EarnApp-Bash directory run:

    bash earnapp-launcher.sh

Existing installation: overwrite package files in the ORIGINAL directory,
keep ea-launcher-data and earnapp.txt. Choose 16, then 1 (or Enter) and your
resolver (default 1.1.1.1) to enable DNS leak. Option 16 rebuilds the router
and applies the setting while retaining volumes and desired stop/start states.
AppArmor is checked automatically during deployment; option 17 also applies it.
Existing container names and their single platform are preserved.

New installation: choose 1. Setup now asks:
  - Dedicated NAT or existing Docker NAT uplink
  - Instance/network prefix (unused default suggested)
  - Subnet/mask/gateway/IP range (unused subnet default suggested)
  - DNS mode: 1 DNS leak (default), 2 DNS-over-HTTPS, 3 Direct proxy DNS
  - DNS leak / proxy DNS: resolver IPv4 (default 1.1.1.1)
  - DoH: assigned proxy or host route, then Cloudflare or Google provider
  - Use multiple platforms? yes / no
  - If yes: how many, then each platform in desired rotation order
  - Proxies in order
  - Container prefix, e.g. node -> node-1, node-2, ...

For two platforms tizen and windows with five proxies, assignment is:
  node-1 -> proxy 1 -> tizen
  node-2 -> proxy 2 -> win
  node-3 -> proxy 3 -> tizen
  node-4 -> proxy 4 -> win
  node-5 -> proxy 5 -> tizen

windows/window/win are accepted and normalized to the included win profile.
macos normalizes to mac. Choices are linux, mac, win, ios, tizen, webos, default.
Counts differ by at most one; assignments are saved per worker and do not shift
when you stop workers or change proxies. One proxy still means one container.
The supplied app preserves platform-specific identity directories in /data.

INDEPENDENT FOLDERS
Each folder stores its own setup and earnapp.txt. New instance and subnet
suggestions use the folder path and avoid existing Docker resources and host
CIDR routes. Worker/volume prefix is user-selectable; if already taken, setup
adds a unique suffix automatically. Network allocation is serialized for
launchers run by the same Linux user. Docker also enforces name/subnet conflicts.
There are no published ports to collide. Existing Docker NAT is shared only
when mode 2 is chosen; the router and worker LAN remain separate per folder.

Router/worker images still build with the requested :latest tags. Each folder
records its build's immutable image ID with --iidfile and creates containers
from those IDs, so another folder's build cannot replace its selected images.
Each build also gets a folder-specific :instance tag.

Copying an already-configured folder archives copied settings/links under
 ea-launcher-data/copied-settings-<timestamp>/
on its first start from another path. It then offers fresh setup and fresh
identity volumes. It never controls the original deployment. For two active
instances, copy/extract to two paths and run Setup in each. Do not move a running
deployment: existing Docker bind mounts still refer to its original path.

APPARMOR — AUTOMATIC
The included apparmor/docker-tun is the profile supplied with this request.
The launcher retains explicit unix rules, runc signal/ptrace rules, and /proc
and /sys restrictions, and renders a separate profile name for each folder.
It tries installed ABI 4.0, ABI 3.0, then no ABI declaration for older parsers.
Each candidate must pass parser validation and kernel loading. Missing ABI 4.0
is no longer fatal. If no candidate loads, diagnostic logs are kept in
ea-launcher-data/apparmor-validate.log and apparmor-load.log.
If Docker uses AppArmor and the local kernel AF_UNIX feature reports yes,
the launcher validates the profile, installs it in /etc/apparmor.d and loads it
with apparmor_parser -r -W. An apt-based host missing the parser gets an
apparmor package installation attempt. Root or sudo access is required.
No apparmor=unconfined or seccomp=unconfined fallback is used.

Router and worker creates receive --security-opt apparmor=<folder-profile>.
Existing containers with another profile are recreated when started/resumed;
named identity volumes remain. Stopped workers remain stopped. Option 17 is
also available before Setup for manual detection/installation. No image rebuild
is needed solely for the host profile. Profiles are left installed on removal.

For Docker Desktop, profile loading must happen on the actual Docker daemon
host; the WSL distro's kernel feature files may not describe the Docker VM.
This does not solve unrelated seccomp, resource-limit or proxy failures.

DASHBOARD
  1 Setup                         2 Status (including each worker platform)
  3 Resume / repair               4 / 5 Stop / start one worker
  6 Change proxy                  7 Collect links
  8 Stop all                      9 / 10 Router / worker logs
  11 Test public IP               12 Remove this deployment, retain volumes
  13 Start all                    14 Rebuild and apply both bundled images
  15 Full mascot                  16 DNS settings: DNS leak / HTTPS / proxy DNS
  17 Detect / install / apply AppArmor
  18 Show this folder's full names, networks and platform assignments

VALIDATION
  bash tests/test-launcher.sh
  bash tests/test-folder-setup.sh
  bash tests/test-dns-apparmor.sh
The second test runs actual setup/deploy/save/load and dashboard dispatch with
a simulated Docker daemon. It verifies two folder setups, collision handling,
balanced platforms, stop isolation, copied settings and option 17 application.
The third test checks older-parser fallback and DNS setting choices. Router
builds run Go tests for DoH wire format, CONNECT destination port 443, direct
routing selection and invalid responses. These Go tests were not run in the
authoring environment (Go and Docker unavailable).
Host AppArmor commands and Docker are mocked. Live image builds, kernel profile
loading and proxy connectivity were not available in the authoring environment.

ADDITIONAL SOURCE-PACKAGE NOTES
===============================
EarnApp Bash Launcher
====================

Extract the WHOLE ZIP into a permanent directory, then run:

    cd EarnApp-Bash
    bash earnapp-launcher.sh

Choose 1 for setup. The included image sources are built automatically; there
is no worker-image prompt and no existing EarnApp image is required.

    docker build -t tun2socks-router:latest ./tun2socks-router
    docker build -t multiplatform-earnapp:latest ./multiplatform-earnapp

Workers use the saved image ID from the multiplatform-earnapp:latest build. Select EARNAPP_CLIENT
when prompted; multiple selections are supported.

The dashboard includes your supplied ASCII mascot, terminal colors, running
worker/link counts, router state, and grouped controls. NO_COLOR=1 disables
colors. Option 15 shows the full artwork; the original text is also preserved
in assets/ascii-art-original.txt. No terminal escape colors are written to pipes.

There is no Python, jq, or embedded source archive in this launcher.
The host needs Bash 4.3+, a local rootful Linux Docker engine, coreutils,
awk, grep and util-linux (flock). Your Docker engine needs /dev/net/tun.
Docker builds need Internet access to Docker Hub and GitHub releases.
Go is used INSIDE the Docker build stage; no host Go installation is needed.
Older Docker CLIs without "docker context show" are supported: endpoint discovery
uses context ls/inspect, and honors DOCKER_CONTEXT and DOCKER_HOST.
This is for Linux containers, including supported WSL Docker integration.
It is not a Windows-container launcher.

Package contents:
  earnapp-launcher.sh            Bash setup and management menu
  tun2socks-router/Dockerfile    Router image build stages
  tun2socks-router/entrypoint.sh Per-client tunnels and source-IP routing
  tun2socks-router/router-start.sh  Isolated firewall and LAN discovery
  tun2socks-router/health.sh     Router process readiness check
  tun2socks-router/dnsrouter/    DNS router Go source and module
  multiplatform-earnapp/         Supplied EarnApp build context and SDK files
  multiplatform-earnapp/launcher-start.sh  Gateway startup integration
  assets/                       Original and terminal-sized ASCII artwork
  tests/test-launcher.sh        Bash logic and Docker-command tests

Network choices:
  1: new dedicated Docker NAT uplink bridge
  2: existing Docker default bridge NAT uplink
Both modes create an isolated worker LAN and ONE router container attached to
the LAN and uplink. This replaces the original Proxmox host-bridge and DHCP
configuration with Docker networking. It does not edit /etc/network/interfaces.

The prompts distinguish Docker's reserved bridge gateway from the router IP.
Workers use the ROUTER IP as their default gateway and DNS server. You select
subnet, netmask, first/last IP, both gateway addresses, and upstream DNS.
Defaults are shown. Worker IP allocation skips every .0, .1 and .255, plus the
real subnet/broadcast addresses and reserved bridge/router addresses.
One pasted proxy = one worker in order, with a matching named volume and the selected prefix.
An insufficient IP range stops setup without creating a partial assignment.

Supported proxy input:
  203.0.113.20:1080
  203.0.113.20:1080:username:password
  socks5://username:password@203.0.113.20:1080
  http://username:password@203.0.113.20:8080
These are format examples; replace them with real proxy addresses.
Use literal IPv4 endpoints. URL-encode special characters in URL credentials;
colon-separated input automatically URL-encodes username/password.
HTTPS proxy endpoints are excluded because the supplied DNS code lacks TLS
to that proxy endpoint. HTTPS WEBSITE traffic through SOCKS5/HTTP CONNECT is fine.
DNS MODES (setup and dashboard option 16)
1 DNS leak (DEFAULT): ordinary DNS directly through the host uplink using
  TCP port 53. The resolver sees the host public IP. DNS bypasses the assigned
  proxy, so that proxy does not need to permit port 53 or UDP.
2 DNS-over-HTTPS: verified HTTPS on destination TCP 443, via the assigned proxy
  by default. Optional direct route exposes the host IP to the DoH provider.
  Choose Cloudflare or Google. Fixed provider IPs avoid bootstrap DNS on 53.
3 Direct proxy DNS: ordinary TCP DNS through each assigned proxy to the chosen
  resolver on port 53. This mode requires the proxy to permit destination 53.

Only DNS routing changes; other worker traffic remains on assigned proxies.
Workers still query the local router on port 53 in every mode. No upstream
UDP is required for DNS. There is no automatic fallback between these modes.
Existing configurations retain their saved DNS mode until option 16 is applied.
The optional direct DoH setting from previous packages remains supported.
Select UDP tunnel only for SOCKS5 proxies that support UDP ASSOCIATE; otherwise
use reject. Proxies cannot carry ordinary ping/ICMP.

Worker image behavior:
The included EarnApp Dockerfile adds static BusyBox and a startup script to
install the router gateway on every managed start, then executes the original
node /app/worker.cjs entrypoint and its run command. Standalone check/profile
commands still work when EA_ROUTER_IP is unset. SDK files are included from
your upload; the launcher does not alter platform/registration behavior.
Workers receive NET_ADMIN for that bootstrap, IPv6 is disabled, and their
resolver file points directly at the router to preserve source-IP DNS routing.
They use --restart unless-stopped, EARNAPP_CLIENT, fixed IP, and /data volumes.
No ports are published. Router routing/firewall rules stay in its namespace.

Management:
  Stop/start specific workers, show logs, change one proxy, collect links,
  stop/start all, resume interrupted setup, test public IP, or remove deployment.
Changing one proxy briefly pauses managed workers, recreates the router to clear
old connections, then starts only workers marked running. Volumes are retained.
Resume respects stopped-worker status. Start all explicitly resumes every worker.
Option 14 rebuilds BOTH bundled images and applies them by recreating managed
containers, retaining their named identity volumes, IPs, proxies, and desired
running/stopped state. This briefly interrupts running workers.
On resume, configurations from the previous Bash package using a different
worker tag migrate to the included image through the same rebuild process.
Extract this ZIP over the SAME directory; keep ea-launcher-data and earnapp.txt.


Links:
Collection reads the actual /data/earnapp.txt from running workers and writes
./earnapp.txt. Line N belongs to worker N of this folder. A worker with no captured link has a blank
line, never a bare https://earnapp.com/r/ placeholder. Previously captured links
are retained when a worker is stopped. Rerun collection for pending registrations.
The included worker creates /data/earnapp.txt after successful registration.

Keep the extracted directory in place after setup. State is stored under
./ea-launcher-data and mounted into containers. Proxy credentials are stored
with restrictive permissions. Docker administrators can still inspect them.
The menu refuses to overwrite other deployments' names or unowned data volumes.
Do not copy state from the earlier Python-based launcher into this version.
If the earlier deployment is running, remove its containers/networks with its
own menu before setting this one up; its volumes have different ownership labels.

Validation:
Run: bash tests/test-launcher.sh
The package was checked with shell syntax validation and Bash tests. Docker was
unavailable in the authoring environment, so live build and proxy egress were
not tested there. Menu 11 tests the worker's actual public IPv4 on your host.
Docker bridge/reference documentation:
https://docs.docker.com/engine/network/drivers/bridge/
https://docs.docker.com/reference/cli/docker/network/create/
