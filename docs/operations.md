# Operations

How to configure, run, ship and verify the studio.

- [Configuration](#configuration)
- [Local development](#local-development)
- [Production build](#production-build)
- [Containers](#containers)
- [Continuous integration](#continuous-integration)
- [Commit policy](#commit-policy)
- [Troubleshooting](#troubleshooting)

## Configuration

Variables are declared and validated in [`src/lib/env.ts`](../src/lib/env.ts) and documented in
[`.env.example`](../.env.example). Copy the template to `.env.local` for development; `.env*`
files other than the template are git-ignored and never reach a container build.

| Variable              | Scope   | Default    | Notes                                                         |
| --------------------- | ------- | ---------- | ------------------------------------------------------------- |
| `BACKEND_SSE_URL`     | server  | (required) | `http(s)` URL of the agent's SSE endpoint                     |
| `AGENT_PROVIDER`      | server  | `upstream` | `mock` serves the deterministic built-in agent, fully offline |
| `NEXT_PUBLIC_API_URL` | client  | (required) | Inlined into the browser bundle at build time; never a secret |
| `SKIP_ENV_VALIDATION` | tooling | empty      | Any value skips validation; for CI lint/typegen only          |

Validation runs three times: when `next.config.ts` loads (build), when the server boots
([`src/instrumentation.ts`](../src/instrumentation.ts), which exits with code 1 on an invalid
environment) and when a route first reads `env`.

## Local development

```bash
pnpm install
AGENT_PROVIDER=mock pnpm dev     # http://localhost:3000, no backend needed
pnpm dev                         # streams from BACKEND_SSE_URL
```

In mock mode the agent infers artifact types from the prompt ("react component", "html page",
"svg logo", "mermaid diagram", "markdown notes", "python script"), runs two simulated tool
calls and streams with a small frame delay. The same mode also serves the agent protocol over
HTTP at `POST /api/mock-agent`, which the offline container profile uses as an upstream.

| Script                          | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| `pnpm dev`                      | Next.js dev server with Turbopack                                       |
| `pnpm build`                    | Type-checked production build, emitted as `.next/standalone`            |
| `pnpm start`                    | Next.js production server (the container runs `node server.js` instead) |
| `pnpm lint` / `pnpm lint:fix`   | Biome check / apply safe fixes                                          |
| `pnpm format`                   | Biome formatter                                                         |
| `pnpm typecheck`                | Route type generation + `tsc --noEmit`                                  |
| `pnpm test` / `pnpm test:watch` | Vitest with coverage / watch mode                                       |
| `pnpm bench`                    | Engineering benchmarks ([benchmarks.md](benchmarks.md))                 |
| `pnpm verify`                   | lint → typecheck → test → attribution audit                             |
| `pnpm audit:attribution`        | Commit identity and message audit                                       |

## Production build

```bash
BACKEND_SSE_URL=https://agent.example/v1/stream NEXT_PUBLIC_API_URL=https://studio.example/api pnpm build
node .next/standalone/server.js   # after copying .next/static and public/ next to it
```

`output: "standalone"` traces only the files the server needs; the image build copies
`.next/static` and `public/` beside it, exactly as the [Dockerfile](../Dockerfile) does.
`GET /api/health` reports liveness and configuration readiness without calling the agent, so an
upstream outage never gets the studio restarted.

## Containers

The [Dockerfile](../Dockerfile) has four stages: `base` (Node.js 24 on Debian slim, the pinned
pnpm, the runtime user), `dependencies` (frozen-lockfile install from a cached store),
`builder` (the standalone build) and `runner` (distroless Node.js 24, non-root
`nextjs:nodejs` 1001:1001, only the standalone output, static assets, `public/` and the
healthcheck script). Base images are pinned by tag and digest.

```bash
docker build -t fullstack-agent-studio .
docker run --rm -p 3000:3000 -e BACKEND_SSE_URL=https://agent.example/v1/stream fullstack-agent-studio
```

[`docker-compose.yml`](../docker-compose.yml) runs the same image hardened: read-only root
filesystem, all capabilities dropped, `no-new-privileges`, a tmpfs for the Next.js cache, the
healthcheck and `restart: unless-stopped`.

```bash
docker compose up --build
docker compose --profile offline up --build studio-offline
```

- `studio` (port 3000) is configured from `.env.example`, overridden by an optional `.env`.
  From inside the container `localhost` is the container itself: point `BACKEND_SSE_URL` at
  `host.docker.internal` for an agent on the host, or set `AGENT_PROVIDER=mock`.
- The `offline` profile runs `studio-offline` (port 3001) against a `mock-agent` container over
  real HTTP. The mock agent sits on an internal network with no route out.

[`scripts/docker-smoke.sh`](../scripts/docker-smoke.sh) builds the image, starts the offline
profile, waits for both healthchecks, then checks the image user and streams one chat turn end
to end. `SMOKE_SKIP_BUILD=1` reuses an existing image; `SMOKE_PORT` changes the host port.

## Continuous integration

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs on pushes to `main` and pull
requests into `main`, cancelling superseded runs.

1. **verify:** full-history checkout → attribution audit → pnpm (from `packageManager`) and
   Node.js (from `.nvmrc`) with the pnpm store cached → frozen install → lint → typecheck →
   tests with coverage (report uploaded) → production build with `.next/cache` restored →
   standalone bundle check.
2. **docker** (after verify): Buildx build of the `runner` target with a GitHub Actions layer
   cache, then the smoke test against that image.

Every action is pinned to a full commit SHA, the token is read-only, no secrets are used, and
no `${{ }}` expression is interpolated into shell code; [`tests/ci.test.ts`](../tests/ci.test.ts)
fails the build if any of that regresses.

## Commit policy

Every commit must be authored _and_ committed by the repository's sole contributor, and commit
messages must not carry AI attribution (`Co-authored-by:`, `Generated-by:`, signatures and the
like). The policy lives in [`.githooks/_policy.sh`](../.githooks/_policy.sh) and is enforced by
the `pre-commit`, `commit-msg` and `pre-push` hooks and by
[`scripts/audit-attribution.sh`](../scripts/audit-attribution.sh) in CI.

On pull requests CI audits the PR head and its history (GitHub's synthetic merge commit is
skipped). Merging through the GitHub web UI records GitHub as the committer and would fail the
next audit on `main`, so changes land by rebasing or fast-forwarding locally and pushing.

## Troubleshooting

| Symptom                                             | Cause and fix                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `❌ Invalid environment variables` at build or boot | A required variable is missing or not an `http(s)` URL; compare with `.env.example`                                                      |
| Container exits with code 1 right after start       | Same as above: [`instrumentation.ts`](../src/instrumentation.ts) refuses to boot with an invalid environment                             |
| `docker compose up` is healthy but chat fails       | `BACKEND_SSE_URL` points at `localhost` inside the container; use `host.docker.internal` or `AGENT_PROVIDER=mock`                        |
| Chat shows "Too many requests"                      | The agent returned 429 more often than the retry budget allows; wait and press Retry                                                     |
| A preview says "Preview disabled"                   | The artifact hung twice and the circuit breaker opened; ask the agent for a fix                                                          |
| Attribution audit fails in CI                       | A commit has a foreign author/committer or an AI trailer; rewrite it locally before pushing                                              |
| `pnpm test` fails with "network call(s)"            | A test tried to open a socket, resolve DNS or spawn a process; intercept it in-process (see [testing.md](testing.md#hermetic-isolation)) |
