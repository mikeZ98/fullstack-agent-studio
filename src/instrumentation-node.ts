/** Validate the server environment, or end the process with exit code 1. */
export async function validateEnvironmentOrExit(
  load: () => Promise<unknown> = () => import("./lib/env"),
  exit: (code: number) => never = process.exit,
): Promise<void> {
  try {
    await load();
  } catch {
    // src/lib/env.ts has already logged which variables are invalid.
    console.error("Refusing to start: the server environment is invalid.");
    exit(1);
  }
}
