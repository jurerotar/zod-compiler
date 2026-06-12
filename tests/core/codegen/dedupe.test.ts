import { describe, expect, it } from "vitest";
import { ZodRealError, z } from "zod";
import { FIN_DECL, FIN_DEFERRED_DECL } from "#src/core/iife.js";
import { compileSchemas, type CompiledSchemaInfo } from "#src/core/pipeline.js";

const __zcFin = new Function("__zcMsg", "__zcZodError", `${FIN_DECL}; return __zcFin;`)(
  undefined,
  ZodRealError,
);
const __zcFinD = new Function("__zcMsg", "__zcZodError", `${FIN_DEFERRED_DECL}; return __zcFinD;`)(
  undefined,
  ZodRealError,
);

type Runnable = (input: unknown) => {
  success: boolean;
  data?: unknown;
  error?: { issues: { code: string; path: (string | number)[] }[] };
};

/**
 * Build a runnable validator from a compiled schema + its file's shared block.
 * Mirrors production scope nesting: the shared block sits at the outer (module)
 * scope while each schema's own preamble lives inside an IIFE — so a per-schema
 * `const` (e.g. a record's `__zcHop`) never collides with the shared block's.
 */
function build(info: CompiledSchemaInfo, sharedCode: string): Runnable {
  const fnName = /function (safeParse_\w+)/.exec(info.codegenResult.functionDef)?.[1];
  if (fnName === undefined) throw new Error("no safeParse function in generated code");
  const src = `${sharedCode}\nreturn (function(){\n${info.codegenResult.code}\n${info.codegenResult.functionDef}\nreturn ${fnName};\n})();`;
  return new Function("__zcMsg", "__zcZodError", "__zcFin", "__zcFinD", src)(
    undefined,
    ZodRealError,
    __zcFin,
    __zcFinD,
  ) as Runnable;
}

/** Find a compiled schema by export name (throws if absent). */
function pick(schemas: CompiledSchemaInfo[], name: string): CompiledSchemaInfo {
  const found = schemas.find((s) => s.exportName === name);
  if (found === undefined) throw new Error(`no compiled schema named ${name}`);
  return found;
}

/** Issue shape for parity comparison (code + path; messages depend on locale). */
function shape(r: { success: boolean; error?: { issues: { code: string; path: unknown }[] } }) {
  return r.success
    ? "ok"
    : JSON.stringify(r.error?.issues.map((i) => ({ code: i.code, path: i.path })));
}

function refs(info: CompiledSchemaInfo): string[] {
  const text = info.codegenResult.code + info.codegenResult.functionDef;
  return [...new Set([...text.matchAll(/__zcSw_\d+/g)].map((m) => m[0]))];
}

describe("schema dedupe", () => {
  it("emits one shared walk and references it from every occurrence", () => {
    const Address = z.object({ street: z.string(), city: z.string(), zip: z.string().min(3) });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "Address", schema: Address },
        {
          exportName: "User",
          schema: z.object({ name: z.string(), home: Address, work: Address }),
        },
        { exportName: "Company", schema: z.object({ legalName: z.string(), hq: Address }) },
      ],
      { mode: "inline" },
    );

    // Exactly one shared function, referenced by all three exports.
    expect((shared.code.match(/function __zcSw_\d+/g) ?? []).length).toBe(1);
    for (const s of schemas) {
      expect(refs(s)).toContain("__zcSw_0");
    }
  });

  it("validates byte-identically to zod through the shared walk (valid + nested errors)", () => {
    const Address = z.object({ street: z.string(), city: z.string(), zip: z.string().min(3) });
    const User = z.object({ name: z.string(), home: Address, work: Address });
    const Company = z.object({ legalName: z.string(), hq: Address });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "Address", schema: Address },
        { exportName: "User", schema: User },
        { exportName: "Company", schema: Company },
      ],
      { mode: "inline" },
    );
    const get = (name: string) => build(pick(schemas, name), shared.code);

    const checks: [string, z.ZodType, unknown][] = [
      ["Address", Address, { street: "1 A St", city: "Town", zip: "123" }],
      ["Address", Address, { street: "x", city: "y", zip: "1" }],
      ["Address", Address, "nope"],
      [
        "User",
        User,
        {
          name: "Jo",
          home: { street: "a", city: "b", zip: "123" },
          work: { street: "c", city: "d", zip: "456" },
        },
      ],
      // nested error: home.zip too small AND work not an object — distinct paths through the same shared walk
      ["User", User, { name: "Jo", home: { street: "a", city: "b", zip: "1" }, work: 5 }],
      ["Company", Company, { legalName: "Co", hq: { street: "a", city: "b", zip: "x" } }],
    ];
    for (const [name, zod, input] of checks) {
      const compiled = get(name)(input);
      const native = zod.safeParse(input);
      expect(compiled.success).toBe(native.success);
      expect(shape(compiled)).toBe(shape(native));
    }
  });

  it("is a no-op when no shape repeats", () => {
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ a: z.string(), b: z.number() }) },
        { exportName: "B", schema: z.object({ c: z.boolean(), d: z.string().email() }) },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toBe("");
    for (const s of schemas) expect(refs(s)).toHaveLength(0);
  });

  it("does not share trivial shapes below the weight threshold", () => {
    // A bare repeated string appears many times but is too small to share.
    const { shared } = compileSchemas(
      [
        { exportName: "A", schema: z.object({ a: z.string(), b: z.string() }) },
        { exportName: "B", schema: z.object({ c: z.string(), d: z.string() }) },
      ],
      { mode: "inline" },
    );
    expect(shared.code).toBe("");
  });

  it("delegates a root walk when the root shape is itself shared", () => {
    const Row = z.object({ id: z.number().int(), name: z.string(), active: z.boolean() });
    const { schemas } = compileSchemas(
      [
        { exportName: "Row", schema: Row },
        { exportName: "Wrapper", schema: z.object({ row: Row, count: z.number() }) },
      ],
      { mode: "inline" },
    );
    // Row's own slow walk should be the delegate call, not a re-inlined object walk.
    const row = pick(schemas, "Row");
    expect(refs(row)).toHaveLength(1);
    // The deferred walk body should contain the shared call and not push object issues itself.
    expect(row.codegenResult.code).toContain("__zcSw_0(");
  });

  it("keeps the fast path fully inlined (never shares the hot path)", () => {
    const Address = z.object({ street: z.string(), city: z.string(), zip: z.string() });
    const { schemas } = compileSchemas(
      [
        { exportName: "User", schema: z.object({ a: Address, b: Address }) },
        { exportName: "Co", schema: z.object({ hq: Address }) },
      ],
      { mode: "inline" },
    );
    const user = pick(schemas, "User");
    // The hosted fast-check function inlines the nested Address check — no shared call.
    const fastFn = /function __fc_\d+\(input\)\{return ([^;]*);\}/.exec(user.codegenResult.code);
    const fastBody = fastFn?.[1] ?? "";
    expect(fastBody).not.toBe("");
    expect(fastBody).not.toContain("__zcSw");
    expect(fastBody).toContain('input["a"]["street"]');
  });

  it("excludes mutation-bearing roots from sharing (cold-path-only guarantee)", () => {
    const Shape = z.object({ a: z.string(), b: z.string(), c: z.string() });
    const { schemas } = compileSchemas(
      [
        { exportName: "R1", schema: z.object({ x: Shape, y: Shape }) },
        { exportName: "R2", schema: z.object({ z: Shape }) },
        // Mutation root (coerce) embedding the same shape — must stay fully inline.
        { exportName: "M", schema: z.object({ w: Shape, n: z.coerce.number() }) },
      ],
      { mode: "inline" },
    );
    expect(refs(pick(schemas, "R1"))).toContain("__zcSw_0");
    expect(refs(pick(schemas, "R2"))).toContain("__zcSw_0");
    // The mutation root inlines its copy — sharing it would run on its eager path.
    expect(refs(pick(schemas, "M"))).toHaveLength(0);
  });

  it("excludes recursive shapes and still validates correctly", () => {
    const makeTree = () => {
      const Tree: z.ZodType = z.lazy(() =>
        z.object({ value: z.number(), children: z.array(Tree) }),
      );
      return Tree;
    };
    const T1 = makeTree();
    const T2 = makeTree();
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "T1", schema: T1 },
        { exportName: "T2", schema: T2 },
      ],
      { mode: "inline" },
    );
    // Recursive shapes are never hoisted into a shared walk.
    expect(shared.code).toBe("");
    expect(refs(pick(schemas, "T1"))).toHaveLength(0);

    const compiled = build(pick(schemas, "T1"), shared.code);
    const valid = { value: 1, children: [{ value: 2, children: [] }] };
    const invalid = { value: "x", children: [] };
    expect(compiled(valid).success).toBe(T1.safeParse(valid).success);
    expect(compiled(invalid).success).toBe(T1.safeParse(invalid).success);
  });

  // Each shared shape exercises a different slow generator (and, for records,
  // a `__zcHop` that also appears in the per-schema fast-path preamble — must
  // not collide across the module/IIFE scope boundary).
  it.each([
    [
      "strictObject",
      z.strictObject({ a: z.string(), b: z.number().int(), c: z.boolean() }),
      [
        { a: "x", b: 1, c: true },
        { a: "x", b: 1.5, c: true },
        { a: "x", b: 1, c: true, extra: 9 },
        "no",
      ],
    ],
    [
      "discriminatedUnion",
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("a"), x: z.number() }),
        z.object({ kind: z.literal("b"), y: z.string().min(2) }),
      ]),
      [{ kind: "a", x: 1 }, { kind: "b", y: "z" }, { kind: "c" }, "no"],
    ],
    [
      "union",
      z.union([
        z.object({ p: z.string(), q: z.number() }),
        z.object({ r: z.boolean(), s: z.string() }),
      ]),
      [{ p: "s", q: 1 }, { p: "s", q: "bad" }, 5],
    ],
    [
      "tuple",
      z.tuple([z.string(), z.number().int(), z.boolean()]),
      [["s", 1, true], ["s", 1.5, true], ["s", 1], "no"],
    ],
    [
      "record",
      z.record(z.string(), z.number().nonnegative()),
      [{ a: 1, b: 2 }, { a: -1 }, { a: "x" }, 5],
    ],
    [
      "refine",
      z.object({ name: z.string().refine((v) => v.length > 2), age: z.number() }),
      [
        { name: "abc", age: 1 },
        { name: "ab", age: 1 },
        { name: "abc", age: "x" },
      ],
    ],
  ] as [string, z.ZodType, unknown[]][])(
    "shares a %s shape and validates identically to zod (standalone + nested)",
    (_name, Shape, inputs) => {
      const Wrap = z.object({ left: Shape, right: Shape });
      const { schemas, shared } = compileSchemas(
        [
          { exportName: "Shape", schema: Shape },
          { exportName: "Wrap", schema: Wrap },
        ],
        { mode: "inline" },
      );
      expect(shared.code).toContain("__zcSw_0");

      const compiledShape = build(pick(schemas, "Shape"), shared.code);
      const compiledWrap = build(pick(schemas, "Wrap"), shared.code);
      for (const input of inputs) {
        expect(shape(compiledShape(input))).toBe(shape(Shape.safeParse(input)));
        const wrapped = { left: input, right: input };
        expect(shape(compiledWrap(wrapped))).toBe(shape(Wrap.safeParse(wrapped)));
      }
    },
  );

  it("keys non-finite check bounds distinctly (no false merge)", () => {
    const A = z.object({
      a: z.number().gte(Number.POSITIVE_INFINITY),
      b: z.string(),
      c: z.boolean(),
    });
    const B = z.object({
      a: z.number().gte(Number.NEGATIVE_INFINITY),
      b: z.string(),
      c: z.boolean(),
    });
    const { schemas, shared } = compileSchemas(
      [
        { exportName: "UsesA1", schema: z.object({ x: A }) },
        { exportName: "UsesA2", schema: z.object({ y: A }) },
        { exportName: "UsesB", schema: z.object({ w: B }) },
      ],
      { mode: "inline" },
    );
    // A repeats → shared once; B's bound differs (−Infinity vs Infinity, both
    // "null" under JSON.stringify) and must NOT merge into A.
    expect((shared.code.match(/function __zcSw_\d+/g) ?? []).length).toBe(1);
    const usesB = build(pick(schemas, "UsesB"), shared.code);
    const sample = { w: { a: 5, b: "x", c: true } };
    expect(shape(usesB(sample))).toBe(shape(z.object({ w: B }).safeParse(sample)));
  });

  it("registers shared runtime helpers for lean-mode imports", () => {
    const Address = z.object({ street: z.string(), city: z.string(), zip: z.string().min(3) });
    const { shared } = compileSchemas(
      [
        { exportName: "User", schema: z.object({ a: Address, b: Address }) },
        { exportName: "Co", schema: z.object({ hq: Address }) },
      ],
      { mode: "lean" },
    );
    // Lean mode routes issue factories through the runtime module; the shared
    // block's helpers must be surfaced so the file imports them.
    expect(shared.code).toContain("__zcSw_0");
    expect([...shared.usedHelpers].length).toBeGreaterThan(0);
    expect(shared.usedHelpers).toContain("__zcIT");
  });
});
