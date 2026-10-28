// @vitest-environment node
// Contract invariants: every exported schema has exactly one inferred type, and no type
// with that name is ever declared by hand anywhere in src/.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMAS_DIR = path.join(ROOT, "src/lib/schemas");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => path.join(dir, file));
}

const schemaModules = sourceFiles(SCHEMAS_DIR).filter((file) => !file.endsWith("index.ts"));
const allSources = sourceFiles(path.join(ROOT, "src"));
const read = (file: string) => readFileSync(file, "utf8");

const schemaNames = schemaModules.flatMap((file) =>
  [...read(file).matchAll(/^export const (\w+)Schema\b/gm)].map((m) => ({
    name: m[1] ?? "",
    file: path.relative(ROOT, file),
  })),
);

describe("schema ⇄ type pairing", () => {
  it("finds the schema modules", () => {
    expect(schemaNames.length).toBeGreaterThan(20);
  });

  it.each(schemaNames)(
    "$name is exported as z.infer<typeof $nameSchema> ($file)",
    ({ name, file }) => {
      const source = read(path.join(ROOT, file));
      expect(source).toContain(`export type ${name} = z.infer<typeof ${name}Schema>;`);
    },
  );

  it.each(schemaNames)("$name has no hand-written duplicate declaration", ({ name }) => {
    // Declarations only (`type X =`, `interface X {`), not `import { type X }`.
    const declaration = new RegExp(
      `\\binterface\\s+${name}\\s*(?:<|\\{|extends)|\\btype\\s+${name}\\s*(?:<[^=]*>)?\\s*=(?!\\s*z\\.infer<typeof ${name}Schema>)`,
    );
    const offenders = allSources.filter((file) => declaration.test(read(file)));
    expect(offenders.map((file) => path.relative(ROOT, file))).toEqual([]);
  });
});

describe("src/types", () => {
  const typeModules = sourceFiles(path.join(ROOT, "src/types")).filter(
    (file) => !file.endsWith(".d.ts"),
  );

  it.each(typeModules.map((file) => path.relative(ROOT, file)))(
    "%s only re-exports inferred contract types",
    (file) => {
      const code = read(path.join(ROOT, file))
        .replace(/\/\/.*$/gm, "")
        .replace(/export type \{[^}]*\} from "[^"]+";/g, "")
        .trim();
      expect(code).toBe("");
    },
  );
});

describe("schemas barrel", () => {
  it("re-exports every schema module", () => {
    const barrel = read(path.join(SCHEMAS_DIR, "index.ts"));
    for (const file of schemaModules) {
      const specifier = `./${path.relative(SCHEMAS_DIR, file).replace(/\.ts$/, "")}`;
      expect(barrel).toContain(`export * from "${specifier}";`);
    }
  });
});
