# Multitap's container image (okf:architecture/overview),
# published as ghcr.io/multitap-media/multitap. Build from the repository root,
# which is the pnpm workspace:
#
#   docker build -t multitap .
#   docker run -d --name multitap -v multitap-data:/data -p 127.0.0.1:8080:8080 multitap
#   docker exec multitap multitap api-key create --scope admin --label me
#
# The build context is filtered by .dockerignore.

# ---- Build: install the workspace, compile, and deploy a pruned Multitap ------
FROM node:26-alpine AS build

# Node 26 has no corepack. Keep in step with package.json#packageManager.
RUN npm install -g pnpm@12.6.0

WORKDIR /repo

# Manifests first, so the dependency layer is reused until they change. Every
# workspace package's package.json is needed for the frozen lockfile check.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/addon-protocol/package.json packages/addon-protocol/
COPY packages/api/package.json packages/api/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/addon-protocol packages/addon-protocol
COPY packages/api packages/api
COPY packages/core packages/core

# tsc -b follows Multitap's project references, so addon-protocol and api build first.
RUN pnpm exec tsc -b packages/core

# A standalone copy of Multitap with production dependencies only. Workspace
# dependencies (@multitap/addon-protocol, @multitap/api) are copied in with
# their dist/, and resolve through their exports' default condition
# (dist/index.js).
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @multitap/core --prod /out

# better-sqlite3 ships prebuilt binaries for every platform; keep only musl.
RUN find /out/node_modules -path '*/better-sqlite3/prebuilds/*' ! -name 'linuxmusl-*' -delete

# Sources copied from a Windows checkout can arrive world-writable.
RUN chmod -R go-w /out /repo/packages/core/migrations

# ---- Runtime --------------------------------------------------------------------
FROM node:26-alpine AS runtime

# Multitap is AGPL-3.0-only; its workspace packages under node_modules/@multitap are MIT.
LABEL org.opencontainers.image.title="Multitap" \
      org.opencontainers.image.description="A headless Stremio client with a remote engine" \
      org.opencontainers.image.url="https://multitap.dev" \
      org.opencontainers.image.source="https://github.com/Multitap-Media/multitap" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production \
    MULTITAP_DATA_DIR=/data \
    MULTITAP_API_PORT=8080

WORKDIR /app

# Owned by root, so the app can't modify its own code; only /data is writable.
COPY --from=build /out/package.json ./package.json
COPY --from=build /repo/packages/core/LICENSE ./LICENSE
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
COPY --from=build /out/dev ./dev
# Loaded as TypeScript by Node's type stripping, from dist/db/../../migrations.
COPY --from=build /repo/packages/core/migrations ./migrations

# `multitap …` runs the admin CLI (okf:architecture/core-api-keys-security): docker exec <container> multitap api-key create …
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/multitap \
    && chmod 755 /usr/local/bin/multitap \
    && mkdir -p /data \
    && chown node:node /data

USER node
VOLUME /data
EXPOSE 8080

# Tries plain HTTP, then HTTPS (built-in TLS, self-signed accepted: it is a
# loopback check). Exits non-zero if both fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "const p=+process.env.MULTITAP_API_PORT||8080;const t=(m,o)=>new Promise(r=>require(m).get({host:'127.0.0.1',port:p,path:'/healthz',timeout:3000,...o},s=>{s.resume();r(s.statusCode===200)}).on('error',()=>r(false)).on('timeout',function(){this.destroy()}));t('http').then(k=>k||t('https',{rejectUnauthorized:false})).then(k=>process.exit(k?0:1))"]

CMD ["node", "dist/index.js"]
