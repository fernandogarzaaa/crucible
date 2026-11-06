# Self-hosted Crucible: API + gateway + web UI in one container.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile && pnpm build

FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app ./
ENV CRUCIBLE_HOME=/data CRUCIBLE_PORT=4800 CRUCIBLE_HOST=0.0.0.0 NODE_ENV=production
VOLUME ["/data"]
EXPOSE 4800
# Set CRUCIBLE_ADMIN_TOKEN when exposing beyond localhost.
CMD ["node", "apps/server/dist/index.js"]
