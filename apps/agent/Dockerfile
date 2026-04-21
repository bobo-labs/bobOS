# ── Stage 1: Install dependencies ─────────────────────────────────────────
FROM node:18-slim AS deps
WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy workspace root config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./

# Copy all package.json files so pnpm can resolve the workspace
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
COPY packages/database/package.json packages/database/package.json

# Install ALL deps
RUN pnpm install --no-frozen-lockfile

# ── Stage 2: Production runner ───────────────────────────────────────────
FROM node:18-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules

# Copy source (no build step needed — tsx runs .ts directly)
COPY apps/agent ./apps/agent
COPY packages ./packages
COPY package.json pnpm-workspace.yaml ./

EXPOSE 3001

CMD ["npx", "tsx", "apps/agent/src/index.ts"]
