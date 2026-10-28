import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

/** Server-only variables. Accessing one of these from client code throws at runtime. */
export const serverSchema = {
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Upstream agent backend endpoint that streams Server-Sent Events. */
  BACKEND_SSE_URL: z.url({ protocol: /^https?$/ }),
  /** `mock` serves the deterministic in-memory agent instead of calling BACKEND_SSE_URL. */
  AGENT_PROVIDER: z.enum(["upstream", "mock"]).default("upstream"),
} as const;

/** Variables inlined into the client bundle; must carry the NEXT_PUBLIC_ prefix. */
export const clientSchema = {
  /** Public base URL of the studio API, used by browser-side fetches. */
  NEXT_PUBLIC_API_URL: z.url({ protocol: /^https?$/ }),
} as const;

/** Raw, unvalidated input; values are `undefined` when unset, exactly like `process.env`. */
export type RuntimeEnv = Partial<
  Record<keyof typeof serverSchema | keyof typeof clientSchema, string | undefined>
>;

interface CreateAppEnvOptions {
  /** Skip validation entirely (lint/typegen in CI without secrets). Never set it at runtime. */
  skipValidation?: boolean;
}

/**
 * Validate `runtimeEnv` against the schemas. Throws on the first invalid or missing variable,
 * so a misconfigured deployment fails at boot instead of at the first request.
 */
export function createAppEnv(runtimeEnv: RuntimeEnv, options: CreateAppEnvOptions = {}) {
  return createEnv({
    server: serverSchema,
    client: clientSchema,
    // Next.js only inlines NEXT_PUBLIC_* values that are referenced statically,
    // so every key is spelled out by the caller instead of passing process.env through.
    runtimeEnv: {
      NODE_ENV: runtimeEnv.NODE_ENV,
      BACKEND_SSE_URL: runtimeEnv.BACKEND_SSE_URL,
      AGENT_PROVIDER: runtimeEnv.AGENT_PROVIDER,
      NEXT_PUBLIC_API_URL: runtimeEnv.NEXT_PUBLIC_API_URL,
    },
    skipValidation: options.skipValidation ?? false,
    // `FOO=` in a .env file means "unset", not "empty string".
    emptyStringAsUndefined: true,
  });
}

export const env = createAppEnv(
  {
    NODE_ENV: process.env.NODE_ENV,
    BACKEND_SSE_URL: process.env.BACKEND_SSE_URL,
    AGENT_PROVIDER: process.env.AGENT_PROVIDER,
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL,
  },
  { skipValidation: Boolean(process.env.SKIP_ENV_VALIDATION) },
);
