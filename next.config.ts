import type { NextConfig } from "next";

// Validate the environment at boot/build time: a misconfigured deployment fails fast
// instead of at the first request. Skippable via SKIP_ENV_VALIDATION (see src/lib/env.ts).
import "./src/lib/env";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: true,
  // Linting is owned by Biome (`pnpm lint`); Next's built-in ESLint step is disabled.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
