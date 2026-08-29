# marketscope self-hosted server — two-stage build.
# Stage 1 builds the esbuild bundle and prunes to runtime deps; stage 2 is the slim runtime.

FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY server ./server
RUN npm run build:server \
 && npm prune --omit=dev   # drop esbuild/vitest/tsx; keeps better-sqlite3 (runtime dep)

FROM node:22-slim
ARG GIT_SHA=unknown
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
# Non-root runtime; /data is the volume mount (marketscope.db + models live there).
RUN useradd -r -u 10001 appuser && mkdir -p /data && chown appuser /data
USER appuser
ENV PORT=8787 DATA_DIR=/data GIT_SHA=${GIT_SHA}
EXPOSE 8787
# Liveness: /health must return 2xx. (node:22 has global fetch.)
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/server.mjs"]
