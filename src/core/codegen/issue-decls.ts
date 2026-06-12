/**
 * Issue factory function bodies (statement form).
 *
 * These functions produce the same `{code, ...}` shapes that lean-mode
 * generated code would otherwise inline at every check site.
 * Hosted in "virtual:zod-compiler/runtime" and called as `__zcTS(...)` etc.
 *
 * Argument convention (positional, kept short to minimize call-site bytes):
 *   __zcTS(minimum, origin, inclusive, input, path, msg?)  — too_small
 *   __zcTB(maximum, origin, inclusive, input, path, msg?)  — too_big
 *   __zcIT(expected, input, path, msg?)                    — invalid_type
 *   __zcIF(format, input, path, extra?, msg?)              — invalid_format (extra merged into result)
 *   __zcIV(values, input, path, msg?)                      — invalid_value
 *   __zcUK(keys, input, path, msg?)                        — unrecognized_keys
 *
 * The trailing msg argument carries a static custom error message; when
 * absent, the __zcFin finalizer applies the configured locale default.
 */

const ZC_TS_DECL =
  'function __zcTS(m,o,i,inp,p,msg){var r={code:"too_small",minimum:m,origin:o,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TS_EXACT_DECL =
  'function __zcTSx(m,o,inp,p,msg){var r={code:"too_small",minimum:m,origin:o,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_DECL =
  'function __zcTB(m,o,i,inp,p,msg){var r={code:"too_big",maximum:m,origin:o,inclusive:i,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_TB_EXACT_DECL =
  'function __zcTBx(m,o,inp,p,msg){var r={code:"too_big",maximum:m,origin:o,inclusive:true,exact:true,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_IT_DECL =
  'function __zcIT(e,inp,p,msg){var r={code:"invalid_type",expected:e,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_IF_DECL =
  'function __zcIF(f,inp,p,extra,msg){var r={code:"invalid_format",format:f,input:inp,path:p};if(extra)Object.assign(r,extra);if(msg!==undefined)r.message=msg;return r;}';

const ZC_IV_DECL =
  'function __zcIV(values,inp,p,msg){var r={code:"invalid_value",values:values,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

const ZC_UK_DECL =
  'function __zcUK(k,inp,p,msg){var r={code:"unrecognized_keys",keys:k,input:inp,path:p};if(msg!==undefined)r.message=msg;return r;}';

/** All issue factory declarations indexed by helper name. */
export const ISSUE_DECLS: Readonly<Record<string, string>> = {
  __zcTS: ZC_TS_DECL,
  __zcTSx: ZC_TS_EXACT_DECL,
  __zcTB: ZC_TB_DECL,
  __zcTBx: ZC_TB_EXACT_DECL,
  __zcIT: ZC_IT_DECL,
  __zcIF: ZC_IF_DECL,
  __zcIV: ZC_IV_DECL,
  __zcUK: ZC_UK_DECL,
};

/**
 * Float-safe remainder — byte-for-byte port of zod's util.floatSafeRemainder.
 * Raw `%` mis-rejects valid multiples of decimal steps (0.3 % 0.1 !== 0);
 * zod scales both operands to integers by their decimal-place count first.
 */
export const ZC_FSR_DECL =
  'function __zcFsr(v,s){var vd=((""+v).split(".")[1]||"").length;var ss=""+s;var sd=(ss.split(".")[1]||"").length;if(sd===0&&/\\d?e-\\d?/.test(ss)){var m=ss.match(/\\d?e-(\\d?)/);if(m&&m[1]){sd=parseInt(m[1],10);}}var d=vd>sd?vd:sd;var vi=parseInt(v.toFixed(d).replace(".",""),10);var si=parseInt(s.toFixed(d).replace(".",""),10);return (vi%si)/Math.pow(10,d);}';

/**
 * Hoisted `Object.prototype.hasOwnProperty` reference. Record fast/slow paths
 * iterate keys with `for(k in o)` (no `Object.keys` array allocation) and guard
 * each key with `__zcHop.call(o,k)` to skip inherited enumerable properties —
 * yielding the exact own-enumerable string-key set `Object.keys` would, so
 * fast/slow stay in agreement and parity with zod's own-key record semantics is
 * preserved. The hoisted reference inlines in V8; reading the prototype property
 * per call would not.
 */
export const ZC_HOP_DECL = "const __zcHop=Object.prototype.hasOwnProperty;";

/** Non-issue runtime helper declarations hosted in the virtual module. */
export const RUNTIME_HELPER_DECLS: Readonly<Record<string, string>> = {
  __zcFsr: ZC_FSR_DECL,
  __zcHop: ZC_HOP_DECL,
};
