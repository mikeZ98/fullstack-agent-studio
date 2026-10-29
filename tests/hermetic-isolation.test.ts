// Hermetic isolation audit: proves the guard from tests/setup/network-guard.ts blocks every
// way out of the process, that the DOM never fetches on its own, and that no test file can
// run without the guard or switch it off. Together with the guard's afterEach (which fails
// any test that attempted network access), every test in the suite runs in memory.
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns, { lookup as namedLookup } from "node:dns";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentClientError, createAgentClient } from "@/lib/tools/agent-client";
import { agentRequest } from "./fixtures/chat";
import {
  assertNoNetworkAttempts,
  drainNetworkAttempts,
  NetworkAccessError,
} from "./setup/network-guard";

// Not `new URL("..", import.meta.url)`: Vite rewrites that pattern into an asset URL.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = "tests/hermetic-isolation.test.ts";
const GUARD = "tests/setup/network-guard.ts";

/** Resolve once the event loop has turned a few times (async egress attempts land by then). */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("hermetic guard — every egress path is blocked and recorded", () => {
  // Each test triggers blocked attempts on purpose; consume them before the global
  // afterEach (registered earlier, so it runs later) treats them as leaks.
  let expected: RegExp;
  afterEach(() => {
    const attempts = drainNetworkAttempts();
    expect(attempts.length).toBeGreaterThan(0);
    for (const attempt of attempts) expect(attempt).toMatch(expected);
  });

  it("fetch, with a URL or a Request", async () => {
    expected = /^https:\/\/api\.example\.com\/v[12]$/;
    await expect(fetch("https://api.example.com/v1")).rejects.toBeInstanceOf(NetworkAccessError);
    await expect(fetch(new Request("https://api.example.com/v2"))).rejects.toThrow(
      "https://api.example.com/v2",
    );
  });

  it("the production agent client when no fetch is injected", async () => {
    expected = /^http:\/\/agent\.invalid\/stream$/;
    const client = createAgentClient({ endpoint: "http://agent.invalid/stream", maxRetries: 0 });
    const error = await client.stream(agentRequest).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentClientError);
    expect((error as AgentClientError).problem.code).toBe("upstream_unavailable");
  });

  it("raw TCP sockets, including loopback", () => {
    expected = /^tcp:\/\/(example\.com:(80|443)|localhost:3000)$/;
    expect(() => net.connect({ host: "example.com", port: 80 })).toThrow(NetworkAccessError);
    expect(() => net.connect(443, "example.com")).toThrow(/tcp:\/\/example\.com:443/);
    expect(() => net.connect(3000)).toThrow(/tcp:\/\/localhost:3000/);
  });

  it("node:http, node:https, node:http2 and node:tls clients", () => {
    expected = /^tcp:\/\/example\.com:(80|443|undefined)$/;
    expect(() => http.get("http://example.com/")).toThrow(NetworkAccessError);
    expect(() => https.get("https://example.com/")).toThrow(NetworkAccessError);
    expect(() => tls.connect({ host: "example.com", port: 443 })).toThrow(NetworkAccessError);
    try {
      http2.connect("https://example.com").on("error", () => undefined);
    } catch (error) {
      expect(error).toBeInstanceOf(NetworkAccessError);
    }
  });

  it("jsdom XMLHttpRequest, async and sync", async () => {
    expected = /^(tcp:\/\/example\.com:80|process:\/\/.+)$/;
    const xhr = new XMLHttpRequest();
    const done = new Promise((resolve) => xhr.addEventListener("loadend", resolve));
    xhr.open("GET", "http://example.com/data.json");
    xhr.send();
    await done;
    expect(xhr.status).toBe(0);

    // Synchronous XHR runs in a jsdom subprocess, which the guard refuses to start.
    const sync = new XMLHttpRequest();
    sync.open("GET", "http://example.com/sync", false);
    expect(() => sync.send()).toThrow();
  });

  it("WebSocket", async () => {
    expected = /^tcp:\/\/example\.com:80$/;
    const socket = new WebSocket("ws://example.com/live");
    await new Promise((resolve) => socket.addEventListener("error", resolve));
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  it("UDP", () => {
    expected = /^udp:\/\/(8\.8\.8\.8:53|localhost:\d+)$/;
    const socket = dgram.createSocket("udp4");
    expect(() => socket.send("x", 53, "8.8.8.8")).toThrow(NetworkAccessError);
    expect(() => socket.bind(41234)).toThrow(NetworkAccessError);
  });

  it("DNS resolution, through every API style", async () => {
    expected = /^dns:\/\/example\.com$/;
    expect(() => dns.lookup("example.com", () => undefined)).toThrow(NetworkAccessError);
    expect(() => namedLookup("example.com", () => undefined)).toThrow(NetworkAccessError);
    expect(() => dns.resolve4("example.com", () => undefined)).toThrow(NetworkAccessError);
    expect(() => new dns.Resolver().resolveTxt("example.com", () => undefined)).toThrow(
      NetworkAccessError,
    );
    await expect(dns.promises.lookup("example.com")).rejects.toBeInstanceOf(NetworkAccessError);
    await expect(new dns.promises.Resolver().resolve6("example.com")).rejects.toBeInstanceOf(
      NetworkAccessError,
    );
  });

  it("listening servers, but not local IPC", () => {
    expected = /^listen:\/\/(0|8080)$/;
    expect(() => http.createServer().listen(0)).toThrow(NetworkAccessError);
    expect(() => net.createServer().listen({ port: 8080 })).toThrow(NetworkAccessError);
  });

  it("subprocesses, which would run outside the guard", () => {
    expected = /^process:\/\/curl( https:\/\/example\.com)?$/;
    expect(() => childProcess.spawn("curl", ["https://example.com"])).toThrow(NetworkAccessError);
    expect(() => childProcess.execSync("curl https://example.com")).toThrow(NetworkAccessError);
  });
});

describe("hermetic guard — the DOM never loads remote resources", () => {
  it("ignores remote src/href on every resource-bearing element", async () => {
    document.body.innerHTML = `
      <img src="http://example.com/a.png">
      <script src="http://example.com/a.js"></script>
      <link rel="stylesheet" href="http://example.com/a.css">
      <iframe src="http://example.com/frame"></iframe>
      <video src="http://example.com/a.mp4"></video>
      <audio src="http://example.com/a.mp3"></audio>
      <object data="http://example.com/a.swf"></object>
      <embed src="http://example.com/a.swf">`;
    const image = new Image();
    image.src = "http://example.com/b.png";
    const script = document.createElement("script");
    script.src = "http://example.com/b.js";
    document.head.append(script);
    await settle();
    expect(drainNetworkAttempts()).toEqual([]);
    document.body.innerHTML = "";
  });
});

describe("hermetic guard — enforcement", () => {
  it("fails a test that attempted network access, naming every target", async () => {
    await fetch("http://leak.example/one").catch(() => undefined);
    expect(() => net.connect(25, "mail.example")).toThrow();
    expect(() => assertNoNetworkAttempts()).toThrow(
      "Test attempted 2 network call(s): http://leak.example/one, tcp://mail.example:25",
    );
    expect(() => assertNoNetworkAttempts()).not.toThrow();
  });

  it("a test may stub fetch for itself...", () => {
    vi.stubGlobal("fetch", async () => new Response("stubbed"));
    expect(globalThis.fetch).not.toBe(undefined);
  });

  it("...but the guard, not the real fetch, comes back afterwards", async () => {
    await expect(fetch("http://after-stub.example/")).rejects.toBeInstanceOf(NetworkAccessError);
    drainNetworkAttempts();
  });
});

describe("hermetic guard — no test can run without it (static audit)", () => {
  const SKIP = new Set(["node_modules", ".next", ".cache", ".git", "coverage"]);
  function walk(dir: string): string[] {
    return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      if (SKIP.has(entry.name)) return [];
      const relative = path.posix.join(dir, entry.name);
      return entry.isDirectory() ? walk(relative) : [relative];
    });
  }
  const files = walk(".");
  const testFiles = files.filter((file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file));
  const sources = files.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/.test(file) &&
      (file.startsWith("tests/") || testFiles.includes(file)) &&
      file !== SELF &&
      file !== GUARD,
  );
  const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
  // Read as text: evaluating the config under jsdom would resolve its URLs against jsdom.
  const config = read("vitest.config.mts");
  const list = (key: string): string[] =>
    JSON.parse(new RegExp(`\\b${key}:\\s*(\\[[^\\]]*\\])`).exec(config)?.[1] ?? "null");
  const flag = (key: string) => new RegExp(`\\b${key}:\\s*true\\b`).test(config);

  it("installs the guard first, before any other setup code", () => {
    expect(list("setupFiles")[0]).toBe(`./${GUARD}`);
  });

  it("restores the guard after every stub, and keeps jsdom from loading resources", () => {
    expect(flag("unstubGlobals")).toBe(true);
    expect(flag("restoreMocks")).toBe(true);
    expect(config).not.toMatch(/environmentOptions|resources/);
  });

  it("runs every test file in the repository under the configured include globs", () => {
    expect(testFiles.length).toBeGreaterThanOrEqual(40);
    const include = list("include");
    expect(include.length).toBeGreaterThan(0);
    for (const file of testFiles) {
      expect(
        include.some((glob) => path.matchesGlob(file, glob)),
        `${file} is not run (or not guarded)`,
      ).toBe(true);
    }
  });

  it("no test patches the network primitives or hides leaks", () => {
    const forbidden: [RegExp, string][] = [
      [/globalThis\.fetch\s*=(?!=)/, "reassigns globalThis.fetch"],
      [/\.prototype\.(connect|listen|send|spawn)\s*=(?!=)/, "patches a socket prototype"],
      [/syncBuiltinESMExports/, "re-syncs builtin exports"],
      [/from\s+["']undici["']/, "imports undici directly"],
      [/drainNetworkAttempts|assertNoNetworkAttempts/, "touches the guard's ledger"],
      [/resources:\s*["']usable["']/, "lets jsdom load resources"],
    ];
    for (const file of sources) {
      const text = read(file);
      for (const [pattern, why] of forbidden)
        expect(pattern.test(text), `${file} ${why}`).toBe(false);
    }
  });

  it("uses only the node and jsdom environments", () => {
    for (const file of testFiles) {
      for (const [, environment] of read(file).matchAll(/@vitest-environment\s+(\S+)/g))
        expect(["node", "jsdom"], file).toContain(environment);
    }
  });

  it("points every agent endpoint at a non-routable host", () => {
    for (const file of sources) {
      for (const [, url] of read(file).matchAll(/endpoint:\s*["'`]([^"'`]+)["'`]/g)) {
        expect(url, file).toMatch(/^(mock:\/\/|https?:\/\/[^/]+\.(invalid|example|test)([/:]|$))/);
      }
    }
  });
});
