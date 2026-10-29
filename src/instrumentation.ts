/**
 * Runs once when the server boots. The standalone server never evaluates next.config.ts
 * (and its env import), so the environment is validated here instead: a misconfigured
 * container exits at startup rather than serving errors.
 */
export async function register(): Promise<void> {
  // Node-only code lives in its own module so the Edge bundle never sees process.exit.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { validateEnvironmentOrExit } = await import("./instrumentation-node");
    await validateEnvironmentOrExit();
  }
}
