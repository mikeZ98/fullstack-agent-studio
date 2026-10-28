// @vitest-environment node
// Repository invariants: package manifest, compiler strictness, layout and env template.
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { clientSchema, serverSchema } from "@/lib/env";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const readJson = <T>(file: string) => JSON.parse(read(file)) as T;

interface PackageJson {
  packageManager?: string;
  type?: string;
  private?: boolean;
  engines?: Record<string, string>;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

interface TsConfig {
  compilerOptions: Record<string, unknown> & { paths?: Record<string, string[]> };
}

const pkg = readJson<PackageJson>("package.json");
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
const majorOf = (name: string) => allDeps[name]?.match(/(\d+)\./)?.[1];

describe("package.json", () => {
  it("pins pnpm 10 as the package manager and stays private ESM", () => {
    expect(pkg.packageManager).toMatch(/^pnpm@10\.\d+\.\d+$/);
    expect(pkg.engines?.["pnpm"]).toBeDefined();
    expect(pkg.engines?.["node"]).toBeDefined();
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
  });

  it.each([
    ["next", "15"],
    ["react", "19"],
    ["react-dom", "19"],
    ["typescript", "5"],
    ["tailwindcss", "4"],
  ])("depends on %s major %s", (name, major) => {
    expect(majorOf(name)).toBe(major);
  });

  it.each([
    "ai",
    "@ai-sdk/react",
    "clsx",
    "tailwind-merge",
    "lucide-react",
    "zod",
    "@t3-oss/env-nextjs",
    "@biomejs/biome",
    "vitest",
    "@vitest/coverage-v8",
    "@testing-library/react",
    "@testing-library/jest-dom",
    "jsdom",
  ])("declares %s", (name) => {
    expect(allDeps).toHaveProperty([name]);
  });

  it("exposes the quality-gate scripts", () => {
    expect(pkg.scripts["lint"]).toContain("--error-on-warnings");
    expect(pkg.scripts["typecheck"]).toContain("tsc --noEmit");
    expect(pkg.scripts["test"]).toMatch(/^vitest run/);
    expect(pkg.scripts["test"]).toContain("--coverage");
  });

  it("is locked by a committed pnpm lockfile", () => {
    expect(existsSync(path.join(ROOT, "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(path.join(ROOT, "package-lock.json"))).toBe(false);
    expect(existsSync(path.join(ROOT, "yarn.lock"))).toBe(false);
  });
});

describe("tsconfig.json", () => {
  const { compilerOptions } = readJson<TsConfig>("tsconfig.json");

  it.each([
    "strict",
    "noUncheckedIndexedAccess",
    "exactOptionalPropertyTypes",
    "noImplicitOverride",
    "noImplicitReturns",
    "noFallthroughCasesInSwitch",
    "isolatedModules",
    "noEmit",
  ])("enables %s", (flag) => {
    expect(compilerOptions[flag]).toBe(true);
  });

  it("does not allow plain JavaScript sources", () => {
    expect(compilerOptions["allowJs"]).toBe(false);
  });

  it("maps @/* to ./src/*", () => {
    expect(compilerOptions.paths).toEqual({ "@/*": ["./src/*"] });
  });
});

describe("directory layout", () => {
  it.each(["src/app", "src/components", "src/lib", "src/types", "tests", ".githooks", "scripts"])(
    "has %s/",
    (dir) => {
      expect(statSync(path.join(ROOT, dir)).isDirectory()).toBe(true);
    },
  );

  it.each([
    "src/app/layout.tsx",
    "src/app/page.tsx",
    "src/app/globals.css",
    "src/lib/env.ts",
    "src/lib/utils.ts",
    "next.config.ts",
    "postcss.config.mjs",
    "biome.json",
    "vitest.config.mts",
    ".env.example",
  ])("has %s", (file) => {
    expect(statSync(path.join(ROOT, file)).isFile()).toBe(true);
  });

  it("has executable attribution tooling", () => {
    for (const file of [
      "scripts/audit-attribution.sh",
      ".githooks/pre-commit",
      ".githooks/commit-msg",
      ".githooks/pre-push",
    ]) {
      expect(statSync(path.join(ROOT, file)).mode & 0o111, file).not.toBe(0);
    }
  });
});

describe(".gitignore", () => {
  const ignored = read(".gitignore")
    .split("\n")
    .map((line) => line.trim());

  it.each([".next/", "node_modules/", ".cache/", "coverage/", ".env", ".env.*"])(
    "excludes %s",
    (entry) => {
      expect(ignored).toContain(entry);
    },
  );

  it("keeps the env template tracked", () => {
    expect(ignored).toContain("!.env.example");
  });
});

describe(".env.example", () => {
  const entries = read(".env.example")
    .split("\n")
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => {
      const [key = "", ...value] = line.split("=");
      return { key, value: value.join("=") };
    });
  const keys = entries.map(({ key }) => key);

  it("documents every validated variable (NODE_ENV is set by the runtime)", () => {
    const schemaKeys = [...Object.keys(serverSchema), ...Object.keys(clientSchema)].filter(
      (key) => key !== "NODE_ENV",
    );
    expect([...keys].sort()).toEqual([...schemaKeys, "SKIP_ENV_VALIDATION"].sort());
  });

  it("only exposes NEXT_PUBLIC_* keys that are in the client schema", () => {
    for (const key of keys.filter((k) => k.startsWith("NEXT_PUBLIC_"))) {
      expect(clientSchema).toHaveProperty([key]);
    }
  });

  it("contains no secret values", () => {
    for (const { key, value } of entries) {
      if (/SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE/.test(key)) expect(value, key).toBe("");
      expect(value, key).not.toMatch(/sk-[A-Za-z0-9]|ghp_|AKIA[0-9A-Z]{16}/);
    }
  });
});
