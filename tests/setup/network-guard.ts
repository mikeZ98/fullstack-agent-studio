// Hermetic network guard: every outbound connection attempt made during a test fails
// fast and is recorded. A test that triggers one (even if the code under test swallows
// the error) fails in afterEach. Tests that need HTTP must intercept it in-process.
import net from "node:net";
import { afterEach } from "vitest";

export class NetworkAccessError extends Error {
  constructor(readonly target: string) {
    super(`Network access is blocked in tests (attempted: ${target}).`);
    this.name = "NetworkAccessError";
  }
}

const attempts: string[] = [];

/** Return and clear the recorded connection attempts. */
export function drainNetworkAttempts(): string[] {
  return attempts.splice(0, attempts.length);
}

function block(target: string): NetworkAccessError {
  attempts.push(target);
  return new NetworkAccessError(target);
}

function describeTarget(args: unknown[]): { target: string; ipc: boolean } {
  const [first, second] = args;
  // net.connect()/createConnection() hand Socket#connect a pre-normalized [options, cb] array.
  if (Array.isArray(first)) return describeTarget(first);
  if (typeof first === "string") return { target: `ipc:${first}`, ipc: true };
  if (typeof first === "number")
    return { target: `${String(second ?? "localhost")}:${first}`, ipc: false };
  if (first !== null && typeof first === "object") {
    const opts = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof opts.path === "string") return { target: `ipc:${opts.path}`, ipc: true };
    return { target: `${String(opts.host ?? "localhost")}:${String(opts.port)}`, ipc: false };
  }
  return { target: "unknown", ipc: false };
}

// Covers http(s), undici (fetch/WebSocket), jsdom's XHR and raw net/tls sockets:
// they all funnel through Socket#connect. Local IPC (unix sockets/pipes) stays allowed
// because the test runner itself may rely on it.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const { target, ipc } = describeTarget(args);
  if (ipc) return Reflect.apply(originalConnect, this, args) as net.Socket;
  throw block(`tcp://${target}`);
} as typeof net.Socket.prototype.connect;

// Reject immediately with a descriptive error instead of waiting on DNS or a timeout.
globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString();
  throw block(url);
};

afterEach(() => {
  const leaked = drainNetworkAttempts();
  if (leaked.length > 0) {
    throw new Error(`Test attempted ${leaked.length} network call(s): ${leaked.join(", ")}`);
  }
});
