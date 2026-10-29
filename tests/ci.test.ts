// @vitest-environment node
// The CI pipeline as code: .github/workflows/ci.yml is parsed and checked against the
// repository it gates (package scripts, toolchain pins, Dockerfile, compose and scripts).
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { clientSchema, serverSchema } from "@/lib/env";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
}

interface Job {
  name: string;
  "runs-on": string;
  needs?: string | string[];
  "timeout-minutes"?: number;
  steps: Step[];
}

interface Workflow {
  name: string;
  on: Record<string, { branches?: string[] }>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  permissions: Record<string, string>;
  env?: Record<string, string>;
  defaults?: { run?: { shell?: string } };
  jobs: Record<string, Job>;
}

const WORKFLOW = ".github/workflows/ci.yml";
const workflowText = read(WORKFLOW);
const workflow = parseYaml(workflowText) as Workflow;
const job = (id: string) => {
  const found = workflow.jobs[id];
  if (found === undefined) throw new Error(`no job ${id}`);
  return found;
};
const action = (j: Job, name: string) => {
  const step = j.steps.find((s) => s.uses?.split("@")[0] === name);
  if (step === undefined) throw new Error(`no ${name} step`);
  return step;
};
const runs = (j: Job) => j.steps.flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));
const indexOfRun = (j: Job, command: string) => runs(j).findIndex((r) => r.startsWith(command));

const pkg = JSON.parse(read("package.json")) as {
  packageManager: string;
  engines: Record<string, string>;
  scripts: Record<string, string>;
};

describe("ci.yml — triggers and run control", () => {
  it("parses as a workflow with the verify and docker jobs", () => {
    expect(workflow.name).toBe("CI");
    expect(Object.keys(workflow.jobs)).toEqual(["verify", "docker"]);
  });

  it("runs on pushes to main and on pull requests into main, nothing else", () => {
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    });
    // pull_request_target would run untrusted PR code with a privileged token.
    expect(workflowText).not.toMatch(/pull_request_target|workflow_run/);
  });

  it("cancels superseded runs of the same branch or pull request", () => {
    expect(workflow.concurrency["cancel-in-progress"]).toBe(true);
    expect(workflow.concurrency.group).toContain("github.workflow");
    expect(workflow.concurrency.group).toContain("github.event.pull_request.number");
    expect(workflow.concurrency.group).toContain("github.ref");
  });

  it("grants the token read-only repository access and uses no secrets", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflowText).not.toMatch(/\bsecrets\.[A-Za-z_]|github\.token|GITHUB_TOKEN/);
  });

  it.each(["verify", "docker"])("runs %s on ubuntu-latest with a timeout", (id) => {
    expect(job(id)["runs-on"]).toBe("ubuntu-latest");
    expect(job(id)["timeout-minutes"]).toBeGreaterThan(0);
    expect(job(id)["timeout-minutes"]).toBeLessThanOrEqual(30);
  });
});

describe("ci.yml — supply chain and runner hygiene", () => {
  const usesLines = workflowText.split("\n").filter((line) => /^\s*uses:/.test(line));

  it("pins every action to a full commit SHA from an official publisher, tagged with its release", () => {
    expect(usesLines.length).toBeGreaterThanOrEqual(8);
    for (const line of usesLines) {
      expect(line).toMatch(
        /^\s+uses: (actions|pnpm|docker)\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/,
      );
    }
  });

  it("pins the same action to the same commit everywhere", () => {
    const pins = new Map<string, Set<string>>();
    for (const line of usesLines) {
      const [, name = "", sha = ""] = /uses: ([^@]+)@(\S+)/.exec(line) ?? [];
      pins.set(name, (pins.get(name) ?? new Set()).add(sha));
    }
    for (const [name, shas] of pins) expect(shas.size, name).toBe(1);
  });

  it("never persists the checkout token", () => {
    for (const id of ["verify", "docker"]) {
      expect(action(job(id), "actions/checkout").with?.["persist-credentials"]).toBe(false);
    }
  });

  it("needs no root on the runner, and interpolates no expressions into shell code", () => {
    for (const j of Object.values(workflow.jobs)) {
      for (const run of runs(j)) {
        expect(run).not.toMatch(/\bsudo\b|--privileged|--user[= ]root/);
        // Untrusted event data must reach scripts through env, never through ${{ }}.
        expect(run).not.toContain("${{");
      }
    }
    expect(workflow.defaults?.run?.shell).toBe("bash");
  });
});

describe("ci.yml — verify job", () => {
  const verify = job("verify");

  it("checks out the full history and audits attribution before anything else", () => {
    expect(verify.steps[0]?.uses?.split("@")[0]).toBe("actions/checkout");
    expect(action(verify, "actions/checkout").with?.["fetch-depth"]).toBe(0);
    const audit = verify.steps[1];
    expect(audit?.run).toBe('bash scripts/audit-attribution.sh "$AUDIT_REV"');
    // Pull requests: the PR head, not GitHub's synthetic merge commit; pushes: the commit.
    expect(audit?.env?.["AUDIT_REV"]).toBe(
      `\${{ github.event.pull_request.head.sha || github.sha }}`,
    );
  });

  it("installs pnpm from package.json's exact packageManager pin", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    // Without `version`, pnpm/action-setup reads packageManager; both would conflict.
    expect(action(verify, "pnpm/action-setup").with?.["version"]).toBeUndefined();
  });

  it("uses the Node.js LTS from .nvmrc, the same release the Docker image builds on", () => {
    const nvmrc = read(".nvmrc").trim();
    expect(nvmrc).toMatch(/^24\.\d+\.\d+$/);
    expect(action(verify, "actions/setup-node").with).toEqual({
      "node-version-file": ".nvmrc",
      cache: "pnpm",
    });
    expect(read("Dockerfile")).toContain(`ARG NODE_IMAGE=node:${nvmrc}-`);
    expect(pkg.engines["node"]).toContain(`^${nvmrc.split(".")[0]}.`);
  });

  it("sets pnpm up before Node.js, so setup-node can cache the pnpm store", () => {
    const order = verify.steps.map((s) => s.uses?.split("@")[0] ?? s.run?.trim());
    expect(order.indexOf("pnpm/action-setup")).toBeLessThan(order.indexOf("actions/setup-node"));
    expect(indexOfRun(verify, "pnpm install --frozen-lockfile")).toBeGreaterThanOrEqual(0);
  });

  it("runs every gate of `pnpm verify`, then the production build, in order", () => {
    const gates = [
      "pnpm install --frozen-lockfile",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
    ];
    const positions = gates.map((gate) => indexOfRun(verify, gate));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const part of pkg.scripts["verify"]?.split("&&") ?? []) {
      const command = part.trim().replace(/^scripts\//, "bash scripts/");
      expect(
        runs(verify).some((r) => r.startsWith(command)),
        command,
      ).toBe(true);
    }
    expect(runs(verify)).toContain("test -f .next/standalone/server.js");
  });

  it("restores .next/cache before the build, keyed by lockfile and sources", () => {
    const cache = action(verify, "actions/cache");
    expect(cache.with?.["path"]).toBe(".next/cache");
    expect(cache.with?.["key"]).toMatch(/hashFiles\('pnpm-lock\.yaml'\).*hashFiles\('src\/\*\*'/);
    expect(String(cache.with?.["restore-keys"]).trim()).toMatch(/^nextjs-\$\{\{ runner\.os \}\}-/);
    expect(verify.steps.indexOf(cache)).toBeLessThan(
      verify.steps.findIndex((s) => s.run?.trim() === "pnpm build"),
    );
  });

  it("builds with non-secret placeholder env that passes validation", () => {
    const build = verify.steps.find((s) => s.run?.trim() === "pnpm build");
    expect(build?.env).toEqual({
      BACKEND_SSE_URL: "http://agent.invalid/v1/stream",
      NEXT_PUBLIC_API_URL: "http://localhost:3000/api",
    });
    expect(serverSchema.BACKEND_SSE_URL.safeParse(build?.env?.["BACKEND_SSE_URL"]).success).toBe(
      true,
    );
    expect(
      clientSchema.NEXT_PUBLIC_API_URL.safeParse(build?.env?.["NEXT_PUBLIC_API_URL"]).success,
    ).toBe(true);
    // Workflow-wide env reaches the test step too; app settings there would change test results.
    expect(Object.keys(workflow.env ?? {})).toEqual(["NEXT_TELEMETRY_DISABLED"]);
  });

  it("keeps the coverage report even when tests fail", () => {
    const upload = action(verify, "actions/upload-artifact");
    expect(upload.if).toBe(`\${{ !cancelled() }}`);
    expect(upload.with).toMatchObject({ name: "coverage", path: "coverage/" });
  });
});

describe("ci.yml — docker job", () => {
  const docker = job("docker");
  const dockerfileStages = [...read("Dockerfile").matchAll(/^FROM \S+ AS (\S+)$/gm)].map(
    (m) => m[1],
  );
  const compose = parseYaml(read("docker-compose.yml"), { merge: true }) as {
    services: Record<string, { image?: string }>;
  };

  it("runs only after verify passes, on Buildx", () => {
    expect(docker.needs).toBe("verify");
    action(docker, "docker/setup-buildx-action");
  });

  it("builds the Dockerfile's runner target into the image compose runs", () => {
    const build = action(docker, "docker/build-push-action");
    expect(build.with).toMatchObject({
      context: ".",
      file: "Dockerfile",
      target: "runner",
      load: true,
      push: false,
    });
    expect(dockerfileStages).toContain(build.with?.["target"]);
    expect(build.with?.["tags"]).toBe(compose.services["studio"]?.image);
    expect(build.with?.["cache-from"]).toMatch(/^type=gha/);
  });

  it("smoke-tests that image with the offline compose profile", () => {
    const smoke = docker.steps.at(-1);
    expect(smoke?.run?.trim()).toBe("bash scripts/docker-smoke.sh");
    expect(smoke?.env).toEqual({ SMOKE_SKIP_BUILD: "1" });
    const script = read("scripts/docker-smoke.sh");
    expect(script).toContain(`"\${SMOKE_SKIP_BUILD:-0}" == "1"`);
    expect(script).toContain("--no-build --pull never --wait");
    // The smoke test asserts the container's non-root user and a full chat turn.
    expect(script).toContain('[[ "$user" == "nextjs:nodejs" ]]');
    expect(script).toContain("/api/chat");
  });
});

describe("scripts used by CI", () => {
  it.each(["scripts/audit-attribution.sh", "scripts/docker-smoke.sh"])(
    "%s is an executable bash script with strict mode",
    (file) => {
      expect(statSync(path.join(ROOT, file)).mode & 0o111).not.toBe(0);
      const text = read(file);
      expect(text.split("\n")[0]).toBe("#!/usr/bin/env bash");
      expect(text).toContain("set -euo pipefail");
    },
  );

  it("audits every commit reachable from the given revision and refuses shallow history", () => {
    const audit = read("scripts/audit-attribution.sh");
    expect(audit).toContain('git rev-list "$@"');
    expect(audit).toContain("(($#)) || set -- HEAD");
    expect(audit).toContain("git rev-parse --is-shallow-repository");
    for (const check of ["studio_check_identity", "studio_check_message"])
      expect(audit).toContain(check);
  });
});
