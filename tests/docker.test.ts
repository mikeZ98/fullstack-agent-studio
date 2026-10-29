// @vitest-environment node
// Container specs as code: the Dockerfile, .dockerignore, docker-compose.yml and the
// HEALTHCHECK probe are parsed and checked against the repository they package. Hermetic:
// nothing here talks to a Docker daemon (see the Phase 8 notes for the runtime smoke test).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { clientSchema, serverSchema } from "@/lib/env";
import nextConfig from "../next.config";
import { DEFAULT_TIMEOUT_MS, healthUrl, probe } from "../scripts/healthcheck.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

// --- Dockerfile -------------------------------------------------------------------------

interface Instruction {
  keyword: string;
  args: string;
}

interface Stage {
  name: string;
  from: string;
  instructions: Instruction[];
}

/** Parse a Dockerfile: join continuations, drop comments, split into stages. */
function parseDockerfile(text: string) {
  const logical: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || (line === "" && pending === "")) continue;
    if (line.endsWith("\\")) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    logical.push(`${pending}${line}`.trim());
    pending = "";
  }
  const global: Instruction[] = [];
  const stages: Stage[] = [];
  for (const line of logical) {
    const [keyword = "", ...rest] = line.split(/\s+/);
    const instruction = { keyword: keyword.toUpperCase(), args: rest.join(" ") };
    if (instruction.keyword === "FROM") {
      const match = /^(\S+)\s+AS\s+(\S+)$/i.exec(instruction.args);
      stages.push({ from: match?.[1] ?? "", name: match?.[2] ?? "", instructions: [] });
    } else {
      (stages.at(-1)?.instructions ?? global).push(instruction);
    }
  }
  return { global, stages };
}

const dockerfileText = read("Dockerfile");
const dockerfile = parseDockerfile(dockerfileText);
const stage = (name: string) => {
  const found = dockerfile.stages.find((s) => s.name === name);
  if (found === undefined) throw new Error(`no stage ${name}`);
  return found;
};
const argDefault = (instructions: Instruction[], name: string) =>
  instructions
    .find((i) => i.keyword === "ARG" && i.args.startsWith(`${name}=`))
    ?.args.slice(name.length + 1);
const all = (s: Stage, keyword: string) =>
  s.instructions.filter((i) => i.keyword === keyword).map((i) => i.args);
const pkg = JSON.parse(read("package.json")) as {
  packageManager: string;
  scripts: Record<string, string>;
};

describe("Dockerfile — syntax and stages", () => {
  it("declares the BuildKit syntax and uses only known instructions", () => {
    expect(dockerfileText.split("\n")[0]).toBe("# syntax=docker/dockerfile:1");
    const known = new Set([
      "ARG",
      "FROM",
      "ENV",
      "WORKDIR",
      "RUN",
      "COPY",
      "USER",
      "EXPOSE",
      "HEALTHCHECK",
      "CMD",
    ]);
    for (const s of dockerfile.stages)
      for (const { keyword } of s.instructions) expect(known, keyword).toContain(keyword);
  });

  it("builds base → dependencies → builder → runner", () => {
    expect(dockerfile.stages.map((s) => [s.name, s.from])).toEqual([
      ["base", `\${NODE_IMAGE}`],
      ["dependencies", "base"],
      ["builder", "base"],
      ["runner", `\${RUNTIME_IMAGE}`],
    ]);
  });

  it("pins both base images to the same Node.js LTS major, by tag and digest", () => {
    const node = argDefault(dockerfile.global, "NODE_IMAGE") ?? "";
    const runtime = argDefault(dockerfile.global, "RUNTIME_IMAGE") ?? "";
    const nodeMatch = /^node:(22|24)\.\d+\.\d+-[a-z]+-slim@sha256:[0-9a-f]{64}$/.exec(node);
    const runtimeMatch = /^gcr\.io\/distroless\/nodejs(22|24)-debian\d+@sha256:[0-9a-f]{64}$/.exec(
      runtime,
    );
    expect(nodeMatch, node).not.toBeNull();
    expect(runtimeMatch, runtime).not.toBeNull();
    expect(runtimeMatch?.[1]).toBe(nodeMatch?.[1]);
  });

  it("installs exactly the pnpm version package.json pins", () => {
    const version = argDefault(stage("base").instructions, "PNPM_VERSION");
    expect(`pnpm@${version}`).toBe(pkg.packageManager);
    expect(all(stage("base"), "RUN").join(" ")).toContain(`"pnpm@\${PNPM_VERSION}"`);
  });
});

describe("Dockerfile — dependencies and build", () => {
  it("installs from the frozen lockfile through a cached store", () => {
    const deps = stage("dependencies");
    expect(all(deps, "COPY")).toEqual([
      "package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./",
    ]);
    const [run = ""] = all(deps, "RUN");
    expect(run).toMatch(/^--mount=type=cache,id=pnpm-store,target=\/pnpm\/store /);
    expect(run).toContain("pnpm fetch --frozen-lockfile --store-dir /pnpm/store");
    expect(run).toContain("pnpm install --frozen-lockfile --offline --store-dir /pnpm/store");
  });

  it("emits a type-checked standalone build", () => {
    const builder = stage("builder");
    expect(all(builder, "RUN").join(" ")).toMatch(/^pnpm build\b/);
    expect(pkg.scripts["build"]).toBe("next build");
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.outputFileTracingRoot).toBe(ROOT);
    expect(nextConfig.typescript?.ignoreBuildErrors).not.toBe(true);
  });

  it("satisfies build-time env validation without baking server values into the runner", () => {
    const builder = stage("builder");
    const publicUrl = argDefault(builder.instructions, "NEXT_PUBLIC_API_URL");
    const backend = argDefault(builder.instructions, "BACKEND_SSE_URL");
    expect(clientSchema.NEXT_PUBLIC_API_URL.safeParse(publicUrl).success).toBe(true);
    expect(serverSchema.BACKEND_SSE_URL.safeParse(backend).success).toBe(true);
    expect(backend).toMatch(/\.invalid\//);
    expect(all(stage("runner"), "ENV").join(" ")).not.toMatch(/BACKEND_SSE_URL|NEXT_PUBLIC/);
  });

  it("never handles secrets", () => {
    for (const s of [{ instructions: dockerfile.global } as Stage, ...dockerfile.stages]) {
      for (const { keyword, args } of s.instructions) {
        if (keyword === "ARG" || keyword === "ENV")
          expect(args, keyword).not.toMatch(/SECRET|TOKEN|PASSWORD|API_KEY|CREDENTIAL/i);
        if (keyword === "COPY") expect(args).not.toMatch(/\.env\b/);
      }
    }
  });
});

describe("Dockerfile — runner", () => {
  const runner = stage("runner");

  it("creates nextjs:nodejs as 1001:1001 with no login shell, and hands it to the runner", () => {
    const run = all(stage("base"), "RUN").join(" ");
    expect(run).toContain("groupadd --system --gid 1001 nodejs");
    expect(run).toMatch(
      /useradd --system --uid 1001 --gid nodejs .*--shell \/usr\/sbin\/nologin nextjs/,
    );
    expect(all(runner, "COPY")).toEqual(
      expect.arrayContaining([
        "--from=base /etc/passwd.runtime /etc/passwd",
        "--from=base /etc/group.runtime /etc/group",
      ]),
    );
  });

  it("runs as the unprivileged user, set once and never switched back", () => {
    expect(all(runner, "USER")).toEqual(["nextjs:nodejs"]);
    const keywords = runner.instructions.map((i) => i.keyword);
    expect(keywords.indexOf("USER")).toBeLessThan(keywords.indexOf("CMD"));
    // Distroless has no shell: the runner must not RUN anything.
    expect(keywords).not.toContain("RUN");
  });

  it("ships only the standalone server, static assets, public files and the probe", () => {
    const sources = all(runner, "COPY").map((args) => args.split(/\s+/).slice(0, -1).join(" "));
    expect(sources).toEqual([
      "--from=base /etc/passwd.runtime",
      "--from=base /etc/group.runtime",
      "--from=builder /app/.next/standalone",
      "--from=builder /app/.next/static",
      "--from=builder /app/public",
      "--from=builder /app/scripts/healthcheck.mjs",
      "--from=builder --chown=1001:1001 /runtime/next-cache",
    ]);
  });

  it("listens on 0.0.0.0:3000 in production mode", () => {
    const env = all(runner, "ENV").join(" ");
    for (const pair of ["NODE_ENV=production", "PORT=3000", "HOSTNAME=0.0.0.0"])
      expect(env).toContain(pair);
    expect(all(runner, "EXPOSE")).toEqual(["3000"]);
    expect(JSON.parse(all(runner, "CMD")[0] ?? "")).toEqual(["server.js"]);
  });

  it("has a deterministic HEALTHCHECK running the probe script with node", () => {
    const [healthcheck = ""] = all(runner, "HEALTHCHECK");
    const match = /^((?:--[a-z-]+=\S+\s+)+)CMD\s+(\[.*\])$/.exec(healthcheck);
    expect(match).not.toBeNull();
    const flags = Object.fromEntries(
      (match?.[1] ?? "")
        .trim()
        .split(/\s+/)
        .map((flag) => flag.slice(2).split("=")),
    );
    expect(flags).toEqual({ interval: "30s", timeout: "5s", "start-period": "20s", retries: "3" });
    expect(JSON.parse(match?.[2] ?? "")).toEqual(["/nodejs/bin/node", "healthcheck.mjs"]);
  });
});

// --- .dockerignore ----------------------------------------------------------------------

const ignoreRules = read(".dockerignore")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => ({ negate: line.startsWith("!"), pattern: line.replace(/^!/, "") }));

/** Docker semantics: the last matching rule wins; a rule matching a directory covers its contents. */
function isIgnored(file: string): boolean {
  const parts = file.split("/");
  const candidates = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let ignored = false;
  for (const { negate, pattern } of ignoreRules) {
    if (candidates.some((candidate) => path.matchesGlob(candidate, pattern))) ignored = !negate;
  }
  return ignored;
}

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = dir === "." ? entry.name : `${dir}/${entry.name}`;
    // Never descend into the big local-only trees; they are checked by name below.
    if (["node_modules", ".git", ".cache", ".next", "coverage"].includes(entry.name)) return [];
    return entry.isDirectory() ? walk(relative) : [relative];
  });
}
const buildContext = walk(".").filter((file) => !isIgnored(file));

describe(".dockerignore", () => {
  it.each([
    ".git/HEAD",
    ".gitignore",
    ".githooks/pre-commit",
    ".cache/pnpm-store/index",
    "node_modules/next/package.json",
    "src/lib/node_modules/x.js",
    ".next/BUILD_ID",
    "coverage/index.html",
    ".env",
    ".env.local",
    ".env.production",
    ".env.example",
    ".envrc",
    "src/.env",
    "tests/docker.test.ts",
    "src/lib/env.test.ts",
    "src/components/studio.integration.test.tsx",
    "vitest.config.mts",
    "scripts/audit-attribution.sh",
    "scripts/docker-smoke.sh",
    ".github/workflows/ci.yml",
    ".nvmrc",
    "Dockerfile",
    "docker-compose.yml",
  ])("keeps %s out of the build context", (file) => {
    expect(isIgnored(file)).toBe(true);
  });

  it("keeps everything the build needs", () => {
    for (const file of [
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      "next.config.ts",
      "tsconfig.json",
      "postcss.config.mjs",
      "public/robots.txt",
      "scripts/healthcheck.mjs",
      "src/instrumentation.ts",
      "src/app/api/health/route.ts",
    ]) {
      expect(buildContext, file).toContain(file);
    }
  });

  it("sends no tests, secrets or tooling, and nothing in it depends on tests", () => {
    for (const file of buildContext) {
      expect(file).not.toMatch(
        /\.test\.tsx?$|^tests\/|(^|\/)\.env|^\.git|^scripts\/(?!healthcheck\.mjs$)/,
      );
      if (/\.(ts|tsx)$/.test(file)) expect(read(file), file).not.toContain("~tests/");
    }
    expect(buildContext.filter((file) => file.startsWith("src/")).length).toBeGreaterThan(50);
  });

  it("covers every file the Dockerfile copies from the build context", () => {
    const fromContext = dockerfile.stages
      .flatMap((s) => all(s, "COPY"))
      .filter((args) => !args.startsWith("--from="))
      .flatMap((args) => args.split(/\s+/).slice(0, -1));
    expect(fromContext).toEqual([
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      ".npmrc",
      ".",
    ]);
    for (const file of fromContext.filter((f) => f !== ".")) expect(buildContext).toContain(file);
  });
});

// --- docker-compose.yml -----------------------------------------------------------------

interface ComposeService {
  image?: string;
  build?: { context: string; dockerfile: string; target: string; args?: Record<string, string> };
  ports?: string[];
  env_file?: { path: string; required?: boolean }[];
  environment?: Record<string, string>;
  healthcheck?: {
    test: string[];
    interval: string;
    timeout: string;
    retries: number;
    start_period: string;
  };
  restart?: string;
  read_only?: boolean;
  tmpfs?: string[];
  cap_drop?: string[];
  security_opt?: string[];
  profiles?: string[];
  networks?: string[];
  depends_on?: Record<string, { condition: string }>;
  user?: string;
}

const compose = parseYaml(read("docker-compose.yml"), { merge: true }) as {
  name: string;
  services: Record<string, ComposeService>;
  networks: Record<string, { internal?: boolean }>;
};
const services = compose.services;
const service = (name: string) => {
  const found = services[name];
  if (found === undefined) throw new Error(`no service ${name}`);
  return found;
};
const envKeys = new Set([...Object.keys(serverSchema), ...Object.keys(clientSchema)]);
const envExample = Object.fromEntries(
  read(".env.example")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split("=", 2) as [string, string]),
);
/** `${VAR:-default}` → default. */
const interpolationDefault = (value: string) => /^\$\{\w+:-(.*)\}$/.exec(value)?.[1];

describe("docker-compose.yml — services", () => {
  it("defines the studio and the offline profile", () => {
    expect(compose.name).toBe("fullstack-agent-studio");
    expect(Object.keys(services).sort()).toEqual(["mock-agent", "studio", "studio-offline"]);
    expect(service("studio").profiles).toBeUndefined();
    expect(service("mock-agent").profiles).toEqual(["offline"]);
    expect(service("studio-offline").profiles).toEqual(["offline"]);
  });

  it.each(["studio", "mock-agent", "studio-offline"])(
    "%s builds the runner target of the root Dockerfile",
    (name) => {
      const { build, image } = service(name);
      expect(build).toMatchObject({ context: ".", dockerfile: "Dockerfile", target: "runner" });
      expect(dockerfile.stages.map((s) => s.name)).toContain(build?.target);
      expect(image).toBe("fullstack-agent-studio:local");
      const publicUrl = interpolationDefault(build?.args?.["NEXT_PUBLIC_API_URL"] ?? "");
      expect(publicUrl).toBe(envExample["NEXT_PUBLIC_API_URL"]);
    },
  );

  it("maps host port 3000 to the port the image exposes", () => {
    expect(service("studio").ports).toEqual(["3000:3000"]);
    expect(service("studio-offline").ports).toEqual(["3001:3000"]);
    for (const { ports = [] } of Object.values(services))
      for (const mapping of ports)
        expect(mapping.split(":")[1]).toBe(all(stage("runner"), "EXPOSE")[0]);
  });

  it.each(["studio", "mock-agent", "studio-offline"])(
    "%s has the image's healthcheck, a restart policy and a hardened runtime",
    (name) => {
      const s = service(name);
      expect(s.healthcheck?.test).toEqual([
        "CMD",
        ...JSON.parse(
          /CMD\s+(\[.*\])$/.exec(all(stage("runner"), "HEALTHCHECK")[0] ?? "")?.[1] ?? "[]",
        ),
      ]);
      expect(s.healthcheck).toMatchObject({ interval: "30s", timeout: "5s", retries: 3 });
      expect(s.restart).toBe("unless-stopped");
      expect(s.read_only).toBe(true);
      expect(s.cap_drop).toEqual(["ALL"]);
      expect(s.security_opt).toContain("no-new-privileges:true");
      // The only writable app path belongs to the image's runtime user.
      expect(s.tmpfs).toContain("/app/.next/cache:uid=1001,gid=1001,mode=0700");
      expect(s.user).toBeUndefined();
    },
  );
});

describe("docker-compose.yml — environment alignment", () => {
  it("configures the studio from .env.example, overridable by an optional .env", () => {
    expect(service("studio").env_file).toEqual([
      { path: ".env.example" },
      { path: ".env", required: false },
    ]);
    // The template documents every variable the app validates (NODE_ENV is the image's).
    for (const key of envKeys)
      if (key !== "NODE_ENV") expect(Object.keys(envExample)).toContain(key);
    expect(all(stage("runner"), "ENV").join(" ")).toContain("NODE_ENV=production");
  });

  it("sets only variables the app knows, with values it accepts", () => {
    const schema = { ...serverSchema, ...clientSchema } as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean } }
    >;
    for (const [name, s] of Object.entries(services)) {
      for (const [key, value] of Object.entries(s.environment ?? {})) {
        expect(envKeys, `${name}.${key}`).toContain(key);
        expect(schema[key]?.safeParse(value).success, `${name}.${key}=${value}`).toBe(true);
      }
    }
  });

  it("wires the offline studio to the mock agent over an egress-free network", () => {
    const agent = service("mock-agent");
    const studio = service("studio-offline");
    expect(agent.environment?.["AGENT_PROVIDER"]).toBe("mock");
    expect(studio.environment?.["AGENT_PROVIDER"]).toBe("upstream");

    const upstream = new URL(studio.environment?.["BACKEND_SSE_URL"] ?? "");
    expect(upstream.hostname).toBe("mock-agent");
    expect(upstream.port).toBe(all(stage("runner"), "EXPOSE")[0]);
    expect(upstream.pathname).toBe("/api/mock-agent");
    expect(read(`src/app${upstream.pathname}/route.ts`)).toContain("createMockAgentHandler");

    expect(studio.depends_on).toEqual({
      "mock-agent": { condition: "service_healthy", restart: true },
    });
    expect(agent.networks).toEqual(["offline"]);
    expect(studio.networks).toEqual(["default", "offline"]);
    expect(compose.networks["offline"]).toEqual({ internal: true });
  });
});

// --- HEALTHCHECK probe ------------------------------------------------------------------

describe("healthcheck.mjs", () => {
  const respond = (status: number) =>
    (async () => new Response("{}", { status })) as unknown as typeof fetch;

  it("probes /api/health on the container's own PORT", () => {
    expect(healthUrl({})).toBe("http://127.0.0.1:3000/api/health");
    expect(healthUrl({ PORT: "8080" })).toBe("http://127.0.0.1:8080/api/health");
    expect(healthUrl({ PORT: "8080; rm -rf /" })).toBe("http://127.0.0.1:3000/api/health");
    expect(read("src/app/api/health/route.ts")).toContain("export function GET");
  });

  it("is healthy only on a 2xx answer", async () => {
    const url = healthUrl({});
    expect(await probe({ url, fetch: respond(200) })).toBe(true);
    expect(await probe({ url, fetch: respond(500) })).toBe(false);
    expect(await probe({ url, fetch: respond(503) })).toBe(false);
    const refused = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await probe({ url, fetch: refused })).toBe(false);
  });

  it("gives up after its timeout, well inside the HEALTHCHECK timeout", async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
      )) as unknown as typeof fetch;
    expect(await probe({ url: healthUrl({}), timeoutMs: 20, fetch: hang })).toBe(false);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it("depends on nothing but Node.js built-ins (the runner has no node_modules for it)", () => {
    const imports = [...read("scripts/healthcheck.mjs").matchAll(/^import .* from "([^"]+)";$/gm)];
    expect(imports.map((m) => m[1])).toEqual(["node:url"]);
  });
});
