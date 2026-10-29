import { createHealthHandler } from "@/lib/tools/health";

// Probed by the container HEALTHCHECK; must never be cached or prerendered.
export const dynamic = "force-dynamic";

const handleHealth = createHealthHandler({
  // Imported lazily so an invalid environment yields a 500 here instead of a crashed module.
  loadEnv: async () => (await import("@/lib/env")).env,
});

export function GET(): Promise<Response> {
  return handleHealth();
}
