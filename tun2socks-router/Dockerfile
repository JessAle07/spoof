ARG GO_VERSION=1.22
ARG ALPINE_VERSION=3.20

# ------------------------------------------------------- tun2socks (prebuilt)
# Download the pinned upstream tun2socks binary; build dnsrouter from source below.
FROM alpine:${ALPINE_VERSION} AS tun2socks
ARG TUN2SOCKS_VERSION=v2.7.0
RUN apk add --no-cache curl unzip \
 && case "$(uname -m)" in \
      x86_64)    ARCH=amd64 ;; \
      aarch64)   ARCH=arm64 ;; \
      armv7l)    ARCH=armv7 ;; \
      i386|i686) ARCH=386   ;; \
      *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/t2s.zip \
      "https://github.com/xjasonlyu/tun2socks/releases/download/${TUN2SOCKS_VERSION}/tun2socks-linux-${ARCH}.zip" \
 && unzip -q /tmp/t2s.zip -d /tmp/t2s \
 && install -m 0755 "/tmp/t2s/tun2socks-linux-${ARCH}" /usr/local/bin/tun2socks \
 && /usr/local/bin/tun2socks --version

# ------------------------------------------------------------ dnsrouter (ours)
# Standard library only, so this builds with any modern Go.
FROM golang:${GO_VERSION}-alpine AS build
ENV CGO_ENABLED=0
WORKDIR /src
COPY dnsrouter/ ./
RUN go test ./... && go build -trimpath -ldflags "-s -w" -o /out/dnsrouter .

# ---------------------------------------------------------------- runtime stage
FROM alpine:${ALPINE_VERSION}
RUN apk add --no-cache iproute2 iptables curl tini ca-certificates
COPY --from=tun2socks /usr/local/bin/tun2socks /usr/local/bin/tun2socks
COPY --from=build     /out/dnsrouter           /usr/local/bin/dnsrouter
COPY entrypoint.sh router-start.sh health.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/router-start.sh /usr/local/bin/health.sh

ENV ROUTES_FILE="/etc/tun2socks/routes.conf" \
    LAN_IF="eth0" \
    LAN_ADDR="" \
    LOG_LEVEL="info" \
    DNS_UPSTREAM="1.1.1.1:53" \
    DNS_LISTEN="0.0.0.0:53" \
    TUN_MTU="1500" \
    UDP_TIMEOUT="60s" \
    ENGINE="tun2socks" \
    HEV_UDP_MODE="udp" \
    RELAX_RP_FILTER="0"

EXPOSE 53/udp 53/tcp
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/router-start.sh"]
HEALTHCHECK --interval=3s --timeout=2s --start-period=10s --retries=3 CMD ["/usr/local/bin/health.sh"]
