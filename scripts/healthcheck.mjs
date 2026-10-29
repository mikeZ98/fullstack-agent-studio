// Container HEALTHCHECK probe. The runtime image is distroless (no shell, no curl), so the
// probe is a dependency-free Node script: exit 0 when GET /api/health answers 2xx within
// the timeout, exit 1 otherwise. Usage: node healthcheck.mjs
import { pathToFileURL } from "node:url";

export const DEFAULT_TIMEOUT_MS = 3000;

/** The health URL of the server in this container (it binds 0.0.0.0:$PORT). */
export function healthUrl(env = process.env) {
  const port = /^\d{1,5}$/.test(env.PORT ?? "") ? env.PORT : "3000";
  return `http://127.0.0.1:${port}/api/health`;
}

/** True when the endpoint answered 2xx in time; never throws. */
export async function probe({ url, timeoutMs = DEFAULT_TIMEOUT_MS, fetch = globalThis.fetch }) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = (await probe({ url: healthUrl() })) ? 0 : 1;
}
