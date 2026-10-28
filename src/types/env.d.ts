// Ambient typing for the environment keys this app reads. The runtime source of truth
// (validation, defaults, client/server split) is src/lib/env.ts; import `env` from there.
declare namespace NodeJS {
  interface ProcessEnv {
    readonly NODE_ENV?: "development" | "test" | "production";
    readonly BACKEND_SSE_URL?: string;
    readonly AGENT_PROVIDER?: "upstream" | "mock";
    readonly NEXT_PUBLIC_API_URL?: string;
    /** Any non-empty value disables env validation (CI lint/typegen only). */
    readonly SKIP_ENV_VALIDATION?: string;
  }
}
