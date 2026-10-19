# build stage: the whole workspace is needed because server imports @reviewx/action/internal
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY action/package.json action/package.json
COPY server/package.json server/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY action action
COPY server server
RUN pnpm --filter @reviewx/server build

# runtime stage: a single bundled file, no node_modules
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app/server/dist/ ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "index.mjs"]
