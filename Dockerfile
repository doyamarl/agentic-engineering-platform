# syntax=docker/dockerfile:1
# One image per app, built from the workspace. TypeScript runs directly on Node 24 (type
# stripping), so api/worker images ship sources and production dependencies only.

FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY . .
# Make sources readable by the non-root runtime user whatever the builder's umask was.
RUN chmod -R a+rX /repo

FROM base AS api
RUN pnpm install --frozen-lockfile --prod --filter "@aep/api..."
USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]

FROM base AS worker
RUN pnpm install --frozen-lockfile --prod --filter "@aep/worker..."
USER node
ENV NODE_ENV=production
EXPOSE 8081
CMD ["node", "apps/worker/src/main.ts"]

FROM base AS web
RUN pnpm install --frozen-lockfile --filter "@aep/web..." \
 && pnpm --filter @aep/web build \
 && chown -R node:node apps/web/.next
USER node
ENV NODE_ENV=production
EXPOSE 3001
CMD ["pnpm", "--filter", "@aep/web", "start"]

# The mock MCP server of the browser tests (infra/compose/compose.e2e.yaml); never in the quickstart.
FROM base AS mock-mcp
RUN pnpm install --frozen-lockfile --prod --filter "@aep/mock-mcp..."
USER node
EXPOSE 8090
CMD ["node", "tools/mock-mcp/src/main.ts"]

# Postgres with the role bootstrap baked in, so it does not depend on host file permissions.
FROM postgres:18.7-alpine@sha256:1018733457011bf88d81db98cf43aac6d5150afc18787dbe204771fedf80ff95 AS db
COPY --chmod=0755 infra/compose/initdb/ /docker-entrypoint-initdb.d/
