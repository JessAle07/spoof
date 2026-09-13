# syntax=docker/dockerfile:1
# Clean runtime; no layers or files are taken from meowzsitink/edge-worker.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM busybox:1.37.0-musl AS bootstrap
FROM ${NODE_IMAGE}
WORKDIR /app/sdk
COPY sdk/package.json sdk/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY sdk/ ./
WORKDIR /app
COPY worker.cjs registration.cjs platform.cjs fingerprints.cjs version.cjs config.json spoof_config.json ./
COPY tools/ ./tools/
ENV NODE_ENV=production WS_NO_ZCOUNTER=1 EDGE_DATA_DIR=/data
RUN node --check worker.cjs && node --check sdk/client.js && node --check sdk/sdk_conf.js && node worker.cjs check
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD ["node","/app/tools/health.cjs"]
COPY --from=bootstrap /bin/busybox /ea/busybox
COPY launcher-start.sh /ea/launcher-start.sh
ENTRYPOINT ["/ea/busybox","sh","/ea/launcher-start.sh","node","/app/worker.cjs"]
CMD ["run"]
