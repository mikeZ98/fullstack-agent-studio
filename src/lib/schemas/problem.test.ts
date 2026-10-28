import { describe, expect, it } from "vitest";
import { patch, validProblem } from "~tests/fixtures/schemas";
import { LIMITS } from "./limits";
import {
  AppErrorCodeSchema,
  createProblem,
  PROBLEM_DEFAULTS,
  ProblemDetailsSchema,
  UriReferenceSchema,
} from "./problem";

describe("ProblemDetailsSchema (RFC 9457)", () => {
  it("accepts a complete problem", () => {
    expect(ProblemDetailsSchema.parse(validProblem)).toEqual(validProblem);
  });

  it('defaults type to "about:blank"', () => {
    const minimal = { title: "Oops", status: 500, code: "internal" };
    expect(ProblemDetailsSchema.parse(minimal).type).toBe("about:blank");
  });

  it("strips unknown extension members instead of rejecting them (RFC 9457 §3.2)", () => {
    const parsed = ProblemDetailsSchema.parse({ ...validProblem, traceId: "abc", admin: true });
    expect(parsed).not.toHaveProperty("traceId");
    expect(parsed).not.toHaveProperty("admin");
  });

  it("drops a __proto__ member from untrusted JSON", () => {
    const raw: unknown = JSON.parse(
      `{"title":"x","status":500,"code":"internal","__proto__":{"isAdmin":true}}`,
    );
    const parsed = ProblemDetailsSchema.parse(raw);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.keys(parsed)).not.toContain("__proto__");
  });

  it.each([
    ["a 2xx status", { status: 200 }],
    ["a non-integer status", { status: 500.5 }],
    ["a status above 599", { status: 600 }],
    ["an empty title", { title: "   " }],
    ["an unknown code", { code: "teapot" }],
    ["a missing code", { code: undefined }],
    ["a javascript: type", { type: "javascript:alert(1)" }],
    ["an oversized detail", { detail: "x".repeat(LIMITS.problemDetailLength + 1) }],
    [
      "too many errors",
      {
        errors: Array.from({ length: LIMITS.problemErrors + 1 }, () => ({
          path: "",
          message: "x",
        })),
      },
    ],
    ["an error with extra keys", { errors: [{ path: "a", message: "b", extra: 1 }] }],
  ])("rejects %s", (_case, changes) => {
    expect(ProblemDetailsSchema.safeParse(patch(validProblem, changes)).success).toBe(false);
  });
});

describe("UriReferenceSchema", () => {
  it.each([
    "about:blank",
    "https://studio.example/problems/x",
    "http://localhost/p",
    "urn:studio:problem:invalid-frame",
    "tag:studio.example,2026:quota",
    "/problems/invalid-frame",
    "invalid-frame#detail",
    "HTTPS://STUDIO.EXAMPLE/P",
  ])("accepts %s", (uri) => {
    expect(UriReferenceSchema.safeParse(uri).success).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>",
    "vbscript:msgbox",
    "https://studio.example/has space",
    "line\nbreak",
    "",
    `https://studio.example/${"a".repeat(LIMITS.uriLength)}`,
    "http://[::1",
  ])("rejects %j", (uri) => {
    expect(UriReferenceSchema.safeParse(uri).success).toBe(false);
  });
});

describe("createProblem", () => {
  it.each(AppErrorCodeSchema.options)("builds a schema-valid %s problem", (code) => {
    const problem = createProblem(code);
    expect(problem).toEqual({ type: "about:blank", code, ...PROBLEM_DEFAULTS[code] });
    expect(problem.status).toBeGreaterThanOrEqual(400);
  });

  it("applies overrides", () => {
    const errors = [{ path: "delta", message: "Too small" }];
    expect(
      createProblem("invalid_frame", { detail: "bad", instance: "/streams/1", errors }),
    ).toMatchObject({ status: 502, detail: "bad", instance: "/streams/1", errors });
  });

  it("refuses an override that breaks the contract", () => {
    expect(() => createProblem("internal", { instance: "javascript:void(0)" })).toThrow();
  });
});
