import { describe, expect, it } from "vitest";

import { JsonValueSchema, RESERVED_KEYS } from "./json";
import { LIMITS } from "./limits";

function nest(depth: number): unknown {
  let value: unknown = "leaf";
  for (let i = 0; i < depth; i++) value = i % 2 === 0 ? { child: value } : [value];
  return value;
}

describe("JsonValueSchema", () => {
  it.each([
    ["string", "text"],
    ["number", 42.5],
    ["boolean", false],
    ["null", null],
    ["array", [1, "two", null, [true]]],
    ["object", { a: { b: [1, { c: "d" }] } }],
    ["empty object", {}],
  ])("accepts a JSON %s", (_kind, value) => {
    expect(JsonValueSchema.parse(value)).toEqual(value);
  });

  it("accepts a null-prototype object", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(JsonValueSchema.safeParse(value).success).toBe(true);
  });

  it.each([...RESERVED_KEYS])("rejects a nested reserved key %s from JSON.parse", (key) => {
    const raw: unknown = JSON.parse(`{"outer":[{"${key}":{"polluted":true}}]}`);
    const result = JsonValueSchema.safeParse(raw);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({ path: ["outer", 0, key], message: `Reserved key "${key}"` }),
    );
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it.each([
    ["Date", new Date(0)],
    ["Map", new Map([["a", 1]])],
    ["class instance", new (class Point {})()],
  ])("rejects a non-plain %s", (_kind, value) => {
    const result = JsonValueSchema.safeParse({ value });
    expect(result.error?.issues[0]?.message).toBe("Must be a plain JSON object");
  });

  it.each([
    ["undefined", undefined],
    ["function", () => 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 1n],
    ["symbol", Symbol("s")],
  ])("rejects non-JSON value %s", (_kind, value) => {
    expect(JsonValueSchema.safeParse({ value }).success).toBe(false);
  });

  it("accepts nesting up to the depth limit and rejects one level deeper", () => {
    expect(JsonValueSchema.safeParse(nest(LIMITS.jsonDepth)).success).toBe(true);

    const result = JsonValueSchema.safeParse(nest(LIMITS.jsonDepth + 1));
    expect(result.error?.issues[0]?.message).toBe(`Exceeds max depth of ${LIMITS.jsonDepth}`);
  });
});
