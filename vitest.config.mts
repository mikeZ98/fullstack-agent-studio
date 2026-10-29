import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  cacheDir: ".cache/vite",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "~tests": fileURLToPath(new URL("./tests", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    // Order matters: the network guard is installed before anything else can open a socket.
    setupFiles: ["./tests/setup/network-guard.ts", "./tests/setup/dom.ts"],
    // Deterministic, non-routable (RFC 2606 .invalid) values so src/lib/env.ts validates
    // without reading the developer's shell or .env files.
    env: {
      BACKEND_SSE_URL: "http://backend.invalid/v1/stream",
      NEXT_PUBLIC_API_URL: "http://studio.invalid/api",
    },
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      reportsDirectory: "coverage",
      reporter: ["text", "html", "lcov"],
      // Business logic only; route files and ambient types are exercised by the build.
      include: ["src/lib/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.d.ts"],
      thresholds: {
        branches: 90,
        functions: 90,
        lines: 90,
        statements: 90,
        // The same floor per module, so a well-covered module cannot mask a weak one.
        ...Object.fromEntries(
          [
            "src/lib/schemas/**",
            "src/lib/core/**",
            "src/lib/tools/**",
            "src/lib/guardrails/**",
            "src/lib/runner/**",
            "src/components/**",
          ].map((glob) => [glob, { branches: 90, functions: 90, lines: 90, statements: 90 }]),
        ),
      },
    },
  },
});
