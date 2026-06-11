import type { SchemaIR } from "../types.js";
import type { CodeGenContext, CodegenMode } from "./context.js";
import { createFastGen, generateFast } from "./fast-path.js";
import { createSlowGen, generateSlow } from "./slow-path.js";

export interface SharedSchemaRef {
  slowName: string;
  fastName: string | null;
}

export interface SharedSchemaPlan {
  refs: Map<string, SharedSchemaRef>;
  code: string;
  usedHelpers: Set<string>;
}

interface Candidate {
  ir: SchemaIR;
  count: number;
  weight: number;
}

const MIN_SHARED_WEIGHT = 4;

export function schemaKey(ir: SchemaIR): string {
  return stableStringify(ir);
}

export function canShareSchema(ir: SchemaIR): boolean {
  if (containsRuntimeRef(ir)) return false;
  if (containsRecursiveRef(ir)) return false;
  return true;
}

export function createSharedSchemaPlan(
  irs: readonly SchemaIR[],
  mode: CodegenMode,
): SharedSchemaPlan {
  const candidates = new Map<string, Candidate>();
  for (const ir of irs) {
    collectCandidates(ir, candidates);
  }

  const selected = [...candidates.entries()]
    .filter(([, c]) => c.count > 1 && c.weight >= MIN_SHARED_WEIGHT)
    .sort((a, b) => {
      const weightDiff = b[1].weight - a[1].weight;
      if (weightDiff !== 0) return weightDiff;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

  if (selected.length === 0) {
    return { refs: new Map(), code: "", usedHelpers: new Set() };
  }

  const refs = new Map<string, SharedSchemaRef>();
  for (let i = 0; i < selected.length; i++) {
    const key = selected[i]?.[0];
    if (key === undefined) continue;
    refs.set(key, { slowName: `__zcS_${i}`, fastName: null });
  }

  const ctx: CodeGenContext = {
    preamble: [],
    counter: 0,
    fnName: "__zcShared",
    regexCache: new Map(),
    mode,
    usedHelpers: new Set(),
  };
  const functions: string[] = [];

  for (const [key, candidate] of selected) {
    const ref = refs.get(key);
    if (ref === undefined) continue;

    const fast = generateFast(candidate.ir, createFastGen("input", ctx));
    if (fast !== null) {
      ref.fastName = `${ref.slowName}f`;
      functions.push(`function ${ref.fastName}(input){return ${fast};}`);
    }

    const slow = generateSlow(candidate.ir, createSlowGen("input", "_d", "path", "_e", ctx));
    functions.push(
      [
        `function ${ref.slowName}(input,path){`,
        "var _e=[];",
        "var _d=input;",
        slow,
        "if(_e.length===0){return{success:true,data:_d};}",
        "return{success:false,issues:_e};",
        "}",
      ].join("\n"),
    );
  }

  return {
    refs,
    code: ["/* zod-compiler shared schemas */", ...ctx.preamble, ...functions].join("\n"),
    usedHelpers: ctx.usedHelpers,
  };
}

function collectCandidates(ir: SchemaIR, candidates: Map<string, Candidate>): void {
  if (canShareSchema(ir)) {
    const key = schemaKey(ir);
    const existing = candidates.get(key);
    if (existing) {
      existing.count++;
    } else {
      candidates.set(key, { ir, count: 1, weight: schemaWeight(ir) });
    }
  }

  for (const child of childSchemas(ir)) {
    collectCandidates(child, candidates);
  }
}

function schemaWeight(ir: SchemaIR): number {
  switch (ir.type) {
    case "object":
      return 2 + Object.values(ir.properties).reduce((sum, child) => sum + schemaWeight(child), 0);
    case "array":
      return 2 + schemaWeight(ir.element);
    case "tuple":
      return (
        2 +
        ir.items.reduce((sum, child) => sum + schemaWeight(child), 0) +
        (ir.rest === null ? 0 : schemaWeight(ir.rest))
      );
    case "record":
    case "map":
      return 2 + schemaWeight(ir.keyType) + schemaWeight(ir.valueType);
    case "set":
      return 2 + schemaWeight(ir.valueType);
    case "union":
    case "discriminatedUnion":
      return 2 + ir.options.reduce((sum, child) => sum + schemaWeight(child), 0);
    case "intersection":
      return 2 + schemaWeight(ir.left) + schemaWeight(ir.right);
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
      return 1 + schemaWeight(ir.inner);
    case "pipe":
      return 2 + schemaWeight(ir.in) + schemaWeight(ir.out);
    case "effect":
      return 2 + schemaWeight(ir.inner);
    case "string":
    case "number":
    case "bigint":
    case "date":
      return 1 + (ir.checks?.length ?? 0);
    case "literal":
    case "enum":
      return 1 + ir.values.length;
    case "stringBool":
      return 1 + ir.truthy.length + ir.falsy.length;
    default:
      return 1;
  }
}

function containsRuntimeRef(ir: SchemaIR): boolean {
  switch (ir.type) {
    case "fallback":
      return ir.refIndex !== undefined;
    case "default":
    case "catch":
      return true;
    default:
      return childSchemas(ir).some(containsRuntimeRef);
  }
}

function containsRecursiveRef(ir: SchemaIR): boolean {
  if (ir.type === "recursiveRef") return true;
  return childSchemas(ir).some(containsRecursiveRef);
}

function childSchemas(ir: SchemaIR): SchemaIR[] {
  switch (ir.type) {
    case "object":
      return Object.values(ir.properties);
    case "array":
      return [ir.element];
    case "tuple":
      return ir.rest === null ? ir.items : [...ir.items, ir.rest];
    case "record":
    case "map":
      return [ir.keyType, ir.valueType];
    case "set":
      return [ir.valueType];
    case "union":
    case "discriminatedUnion":
      return ir.options;
    case "intersection":
      return [ir.left, ir.right];
    case "optional":
    case "nullable":
    case "readonly":
    case "default":
    case "catch":
      return [ir.inner];
    case "pipe":
      return [ir.in, ir.out];
    case "effect":
      return [ir.inner];
    default:
      return [];
  }
}

function stableStringify(value: unknown): string {
  if (typeof value === "bigint") return `{"$bigint":${JSON.stringify(value.toString())}}`;
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function emitSharedSlowCall(
  ref: SharedSchemaRef,
  input: string,
  output: string,
  path: string,
  issues: string,
  temp: (prefix: string) => string,
): string {
  const result = temp("sr");
  const index = temp("sri");
  return [
    `var ${result}=${ref.slowName}(${input},${path});`,
    `if(${result}.success){${output}=${result}.data;}else{`,
    `for(var ${index}=0;${index}<${result}.issues.length;${index}++){${issues}.push(${result}.issues[${index}]);}`,
    "}",
  ].join("\n");
}

export function canUseSharedFast(ref: SharedSchemaRef | undefined): ref is SharedSchemaRef & {
  fastName: string;
} {
  return ref?.fastName !== null && ref?.fastName !== undefined;
}
