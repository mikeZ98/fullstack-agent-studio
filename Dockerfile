# syntax=docker/dockerfile:1
#
# Production image for the agent studio: the Next.js standalone server on a distroless
# Node.js runtime, running as an unprivileged user (nextjs:nodejs, 1001:1001).
#
#   docker build -t fullstack-agent-studio .
#   docker run --rm -p 3000:3000 -e BACKEND_SSE_URL=https://agent.example/v1/stream \
#     fullstack-agent-studio
#
# Stages: base -> dependencies -> builder -> runner. Only the runner ships. Base images are
# pinned by tag *and* digest for reproducible builds; update both together.

ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:51eee69b25037942014428da85f5b436a4d88f283e545981d03f25b7db72469a

# --- base: Node.js, the pinned pnpm, and the runtime identity ---------------------------
FROM ${NODE_IMAGE} AS base
# Must match "packageManager" in package.json (checked by tests/docker.test.ts).
ARG PNPM_VERSION=10.34.9
ENV CI=1 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The runtime user is created here and its passwd/group entries are handed to the
# distroless runner, which has no useradd.
RUN npm install --global --no-audit --no-fund "pnpm@${PNPM_VERSION}" \
 && groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --home-dir /app --no-create-home \
      --shell /usr/sbin/nologin nextjs \
 && grep -E '^(root|nextjs):' /etc/passwd > /etc/passwd.runtime \
 && grep -E '^(root|nodejs):' /etc/group > /etc/group.runtime

# --- dependencies: exactly what the lockfile says, from a cached store --------------------
FROM base AS dependencies
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
# `fetch` reads only the lockfile, so this layer is reused until dependencies change.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile --store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --offline --store-dir /pnpm/store

# --- builder: type-checked production build, emitted as .next/standalone ------------------
FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* values are inlined into the browser bundle, so they are fixed at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000/api
# Server-only values are read at runtime; this placeholder only satisfies build-time env
# validation and never reaches the runner image.
ARG BACKEND_SSE_URL=http://agent.invalid/v1/stream
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
RUN pnpm build \
 && mkdir -p /runtime/next-cache

# --- runner: distroless, non-root, standalone output only ---------------------------------
FROM ${RUNTIME_IMAGE} AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=base /etc/passwd.runtime /etc/passwd
COPY --from=base /etc/group.runtime /etc/group
# Application files stay owned by root (read-only for the app user); only the runtime cache
# directory is writable.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/scripts/healthcheck.mjs ./healthcheck.mjs
COPY --from=builder --chown=1001:1001 /runtime/next-cache ./.next/cache
USER nextjs:nodejs
EXPOSE 3000
# Distroless has no shell or curl: the probe is a dependency-free Node script.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "healthcheck.mjs"]
# The image's entrypoint is the node binary.
CMD ["server.js"]
