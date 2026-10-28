import { z } from "zod";

import { LIMITS } from "./limits";

/** Keys that rewrite an object's prototype when the object is later copied or spread. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Walk the *raw* input before Zod copies it. Zod's record parser silently drops an own
 * `__proto__` key (as produced by JSON.parse), so a key schema alone can never see it.
 */
function guardRawJson(root: unknown, ctx: z.RefinementCtx): void {
  const stack: { value: unknown; path: PropertyKey[] }[] = [{ value: root, path: [] }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { value, path } = item;
    if (typeof value !== "object" || value === null) continue;
    if (path.length >= LIMITS.jsonDepth) {
      ctx.addIssue({ code: "custom", path, message: `Exceeds max depth of ${LIMITS.jsonDepth}` });
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => {
        stack.push({ value: child, path: [...path, index] });
      });
      continue;
    }
    if (!isPlainObject(value)) {
      ctx.addIssue({ code: "custom", path, message: "Must be a plain JSON object" });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (RESERVED_KEYS.has(key)) {
        ctx.addIssue({ code: "custom", path: [...path, key], message: `Reserved key "${key}"` });
      } else {
        stack.push({ value: child, path: [...path, key] });
      }
    }
  }
}

/**
 * Free-form JSON value (tool inputs/outputs): rejects reserved keys, non-plain objects and
 * excessive nesting, then validates the JSON shape.
 */
export const JsonValueSchema = z.unknown().superRefine(guardRawJson).pipe(z.json());
export type JsonValue = z.infer<typeof JsonValueSchema>;
