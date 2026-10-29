import { createProblem } from "@/lib/schemas";

import { problemResponse } from "./chat-handler";

/**
 * GET /api/health: liveness plus configuration readiness, for container HEALTHCHECKs and
 * orchestrators. It never calls the agent backend, so an upstream outage cannot get the
 * studio restarted; it does fail when the server environment is invalid.
 */

export interface HealthReport {
  status: "ok";
  provider: "mock" | "upstream";
  uptimeSeconds: number;
}

export interface HealthHandlerOptions {
  /** Resolve the validated server environment; rejects when it is invalid. */
  loadEnv: () => Promise<{ AGENT_PROVIDER: HealthReport["provider"] }>;
  /** Seconds the process has been running. */
  uptime?: () => number;
}

export function createHealthHandler(options: HealthHandlerOptions) {
  const { loadEnv, uptime = () => process.uptime() } = options;

  return async function handleHealth(): Promise<Response> {
    let provider: HealthReport["provider"];
    try {
      provider = (await loadEnv()).AGENT_PROVIDER;
    } catch {
      // The validation error itself (variable names, values) belongs in the server log only.
      const detail = "Server configuration is invalid; see the server log";
      return problemResponse(createProblem("internal", { detail }));
    }
    const report: HealthReport = {
      status: "ok",
      provider,
      uptimeSeconds: Math.floor(uptime()),
    };
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  };
}
