// Hermetic network guard: every way out of the process a test could take (TCP/TLS/HTTP
// connections, fetch, UDP, DNS, listening sockets, subprocesses) fails fast and is recorded.
// A test that triggers one (even if the code under test swallows the error) fails in
// afterEach. Tests that need HTTP must intercept it in-process.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
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

/** Throw if anything tried to leave the process since the last check. Runs after every test. */
export function assertNoNetworkAttempts(): void {
  const leaked = drainNetworkAttempts();
  if (leaked.length > 0) {
    throw new Error(`Test attempted ${leaked.length} network call(s): ${leaked.join(", ")}`);
  }
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

// Outbound TCP. Covers http(s), http2, tls, undici (fetch/WebSocket), jsdom's XHR and
// WebSocket, and raw sockets: they all funnel through Socket#connect. Local IPC (unix
// sockets/pipes) stays allowed because the test runner itself may rely on it.
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const { target, ipc } = describeTarget(args);
  if (ipc) return Reflect.apply(originalConnect, this, args) as net.Socket;
  throw block(`tcp://${target}`);
} as typeof net.Socket.prototype.connect;

// Inbound TCP: a listening server is network I/O too (http.Server extends net.Server).
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedListen(this: net.Server, ...args: unknown[]) {
  const [first] = args;
  const pipe = typeof first === "string" && !/^\d+$/.test(first);
  const pathOption =
    first !== null &&
    typeof first === "object" &&
    typeof (first as { path?: unknown }).path === "string";
  if (pipe || pathOption) return Reflect.apply(originalListen, this, args) as net.Server;
  const port =
    typeof first === "object" && first !== null ? (first as { port?: unknown }).port : first;
  throw block(`listen://${String(port ?? 0)}`);
} as typeof net.Server.prototype.listen;

// UDP.
function describeUdp(args: unknown[]): string {
  const port = args.filter((arg) => typeof arg === "number").at(-1);
  const host = args.slice(1).find((arg) => typeof arg === "string") ?? "localhost";
  return `udp://${String(host)}:${String(port ?? "?")}`;
}
for (const method of ["send", "connect", "bind"] as const) {
  dgram.Socket.prototype[method] = function guardedUdp(...args: unknown[]) {
    throw block(describeUdp(method === "send" ? args : [undefined, ...args]));
  } as never;
}

// DNS: name resolution leaves the process even when no connection follows.
const DNS_METHODS = /^(lookup|lookupService|reverse|resolve\w*)$/;
function guardResolver(target: object, mode: "callback" | "promise"): void {
  const record = target as Record<string, unknown>;
  for (const name of Object.keys(record)) {
    if (!DNS_METHODS.test(name) || typeof record[name] !== "function") continue;
    record[name] = (hostname: unknown) => {
      const error = block(`dns://${String(hostname)}`);
      if (mode === "promise") return Promise.reject(error);
      throw error;
    };
  }
}
guardResolver(dns, "callback");
guardResolver(dns.promises, "promise");
for (const [Resolver, mode] of [
  [dns.Resolver, "callback"],
  [dns.promises.Resolver, "promise"],
] as const) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
    if (!DNS_METHODS.test(name)) continue;
    Object.defineProperty(Resolver.prototype, name, {
      configurable: true,
      writable: true,
      value: (hostname: unknown) => {
        const error = block(`dns://${String(hostname)}`);
        if (mode === "promise") return Promise.reject(error);
        throw error;
      },
    });
  }
}

// Subprocesses run outside this guard, so starting one counts as leaving the sandbox.
// ChildProcess#spawn backs spawn/exec/execFile/fork; the *Sync variants are separate.
const childPrototype = childProcess.ChildProcess.prototype as unknown as {
  spawn: (options: { file?: string }) => void;
};
childPrototype.spawn = (options) => {
  throw block(`process://${options.file ?? "unknown"}`);
};
for (const name of ["spawnSync", "execSync", "execFileSync"] as const) {
  (childProcess as Record<typeof name, unknown>)[name] = (file: unknown) => {
    throw block(`process://${String(file)}`);
  };
}

// Make `import { lookup } from "node:dns"` and friends see the guarded functions too.
syncBuiltinESMExports();

// Reject immediately with a descriptive error instead of waiting on DNS or a timeout.
globalThis.fetch = async (input: string | URL | Request): Promise<Response> => {
  const url = input instanceof Request ? input.url : input.toString();
  throw block(url);
};

afterEach(() => {
  assertNoNetworkAttempts();
});
