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

# Install ALL deps (not frozen — ensures platform-native binaries are fetched)
RUN pnpm install --no-frozen-lockfile

# ── Stage 2: Build the agent ─────────────────────────────────────────────
FROM node:18-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/agent/node_modules ./apps/agent/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules

# Copy full source
COPY . .

# Build (tsc compile)
RUN pnpm --filter agent build

# ── Stage 3: Production runner ───────────────────────────────────────────
FROM node:18-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy built output + deps
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/pnpm-workspace.yaml ./pnpm-workspace.yaml

EXPOSE 3001

CMD ["node", "apps/agent/dist/index.js"]
