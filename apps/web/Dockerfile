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

# ── Stage 2: Build the Next.js app ───────────────────────────────────────
FROM node:18-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Copy deps from previous stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/database/node_modules ./packages/database/node_modules

# Copy full source
COPY . .

# Build the Next.js app
RUN pnpm --filter web build

# ── Stage 3: Production runner ───────────────────────────────────────────
FROM node:18-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Next.js standalone output copies everything needed
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public

EXPOSE 3000

CMD ["node", "apps/web/server.js"]
