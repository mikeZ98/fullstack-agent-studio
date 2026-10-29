import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

// Validate the environment at boot/build time: a misconfigured deployment fails fast
// instead of at the first request. Skippable via SKIP_ENV_VALIDATION (see src/lib/env.ts).
import "./src/lib/env";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone) with only the traced runtime files, for
  // the production container image. Tracing is rooted here so a lockfile in a parent
  // directory can never change the bundle layout.
  output: "standalone",
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Linting is owned by Biome (`pnpm lint`); Next's built-in ESLint step is disabled.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
