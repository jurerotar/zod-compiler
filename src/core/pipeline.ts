import type { CodeGenResult, CodegenMode } from "./codegen/context.js";
import { createSharedSchemaPlan, schemaKey } from "./codegen/dedupe.js";
import { generateValidator } from "./codegen/index.js";
import type { RefEntry } from "./extract/index.js";
import { extractSchema } from "./extract/index.js";
import type { DiscoveredSchema, SchemaIR } from "./types.js";

/** Result of compiling a single discovered schema through extract → generate pipeline. */
export interface CompiledSchemaInfo {
  exportName: string;
  codegenResult: CodeGenResult;
  refEntries: RefEntry[];
  /** File-level shared validator declarations, attached to the first compiled schema. */
  sharedCode?: string;
  /** Runtime helpers used by shared validator declarations. */
  sharedUsedHelpers?: Set<string>;
}

export interface CompileSchemasOptions {
  /** "inline" for CLI .compiled.ts; "lean" for unplugin (imports from virtual:zod-compiler/runtime). */
  mode: CodegenMode;
  /** When provided, per-schema failures call this and continue. Otherwise the first error throws. */
  onError?: (exportName: string, error: Error) => void;
}

/**
 * Run the extract → generate pipeline for each discovered schema.
 * Shared by CLI generate and unplugin transform.
 */
export function compileSchemas(
  schemas: DiscoveredSchema[],
  options: CompileSchemasOptions,
): CompiledSchemaInfo[] {
  const extracted: Array<{
    exportName: string;
    ir: SchemaIR;
    refEntries: RefEntry[];
  }> = [];

  for (const s of schemas) {
    try {
      const refEntries: RefEntry[] = [];
      const ir = extractSchema(s.schema, refEntries);
      extracted.push({ exportName: s.exportName, ir, refEntries });
    } catch (err) {
      if (options.onError) {
        options.onError(s.exportName, err instanceof Error ? err : new Error(String(err)));
      } else {
        throw err;
      }
    }
  }

  const sharedSchemas = createSharedSchemaPlan(
    extracted.map((s) => s.ir),
    options.mode,
  );
  const results: CompiledSchemaInfo[] = [];

  for (const s of extracted) {
    try {
      const codegenResult = generateValidator(s.ir, s.exportName, {
        refCount: s.refEntries.length,
        mode: options.mode,
        sharedSchemas,
        rootKey: schemaKey(s.ir),
      });
      results.push({ exportName: s.exportName, codegenResult, refEntries: s.refEntries });
    } catch (err) {
      if (options.onError) {
        options.onError(s.exportName, err instanceof Error ? err : new Error(String(err)));
      } else {
        throw err;
      }
    }
  }

  if (results.length > 0 && sharedSchemas.code !== "") {
    const first = results[0];
    if (first !== undefined) {
      first.sharedCode = sharedSchemas.code;
      first.sharedUsedHelpers = sharedSchemas.usedHelpers;
    }
  }

  return results;
}

/**
 * Aggregate `usedHelpers` across multiple compiled schemas (typically all schemas in one file).
 * Used by the unplugin transform to construct a single import statement per file.
 */
export function aggregateUsedHelpers(schemas: CompiledSchemaInfo[]): Set<string> {
  const all = new Set<string>();
  for (const s of schemas) {
    for (const h of s.codegenResult.usedHelpers) all.add(h);
    for (const h of s.sharedUsedHelpers ?? []) all.add(h);
  }
  return all;
}

export function getSharedSchemaCode(schemas: CompiledSchemaInfo[]): string {
  return schemas.find((s) => s.sharedCode !== undefined)?.sharedCode ?? "";
}
