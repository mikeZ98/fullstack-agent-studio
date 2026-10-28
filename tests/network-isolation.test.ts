// Proves the hermetic guard from tests/setup/network-guard.ts actually holds.
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { drainNetworkAttempts, NetworkAccessError } from "./setup/network-guard";

describe("hermetic network guard", () => {
  // Each test triggers blocked attempts on purpose; consume them before the global
  // afterEach (registered earlier, so it runs later) treats them as leaks.
  afterEach(() => {
    expect(drainNetworkAttempts().length).toBeGreaterThan(0);
  });

  it("rejects fetch", async () => {
    await expect(fetch("https://api.example.com/v1")).rejects.toBeInstanceOf(NetworkAccessError);
  });

  it("rejects fetch with a Request object", async () => {
    await expect(fetch(new Request("https://api.example.com/v2"))).rejects.toThrow(
      "https://api.example.com/v2",
    );
  });

  it("blocks raw TCP sockets", () => {
    expect(() => net.connect({ host: "example.com", port: 80 })).toThrow(NetworkAccessError);
    expect(() => net.connect(443, "example.com")).toThrow(/tcp:\/\/example\.com:443/);
  });

  it("blocks node:http and node:https clients", () => {
    expect(() => http.get("http://example.com/")).toThrow(NetworkAccessError);
    expect(() => https.get("https://example.com/")).toThrow(NetworkAccessError);
  });

  it("blocks loopback too: servers must be intercepted in-process", () => {
    expect(() => net.connect(3000)).toThrow(/tcp:\/\/localhost:3000/);
  });
});
