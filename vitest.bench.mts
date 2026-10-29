import { defineConfig } from "vitest/config";

import base from "./vitest.config.mjs";

// `pnpm bench`: the engineering benchmarks under tests/benchmarks, with the same hermetic
// setup as the test suite but without coverage instrumentation (it would skew timings).
// Spread rather than mergeConfig: merging would append to `include` instead of replacing it.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["tests/benchmarks/**/*.bench.ts"],
    coverage: { ...base.test?.coverage, enabled: false },
    testTimeout: 120_000,
  },
});
