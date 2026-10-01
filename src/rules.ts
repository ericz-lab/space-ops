import type { Assertion, Rule, Sample } from "./types.ts";

function integer(v: unknown, fallback: number, min: number, max: number, name: string): number {
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || Number(v) < min || Number(v) > max) throw new Error(`${name}: expected an integer from ${min} to ${max}`);
  return Number(v);
}
export function validateRule(raw: unknown, id: string = crypto.randomUUID()): Rule {
  if (!raw || typeof raw !== "object") throw new Error("Rule must be an object");
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "").trim();
  if (!name || name.length > 120) throw new Error("Name must contain 1–120 characters");
  const url = new URL(String(r.url ?? ""));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Use an HTTP(S) URL without credentials or fragment");
  if (url.href.length > 2000) throw new Error("URL too long");
  if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error("enabled must be boolean");
  const assertions = r.assertions ?? [];
  if (!Array.isArray(assertions) || assertions.length > 20) throw new Error("At most 20 assertions are allowed");
  for (const a of assertions) {
    if (!a || typeof a !== "object" || typeof a.path !== "string" || !/^\$(?:\.[a-zA-Z0-9_-]+|\[\d+\])*$/.test(a.path) || a.path.length > 200) throw new Error("Use a field path such as $.output.verified or $.items[0].count");
    if (!["exists", "eq", "lt", "gt", "ageLessThan"].includes(a.operator)) throw new Error("Unsupported assertion operator");
    if (["lt", "gt", "ageLessThan"].includes(a.operator) && (typeof a.value !== "number" || !Number.isFinite(a.value) || (a.operator === "ageLessThan" && a.value <= 0))) throw new Error("Numeric assertions need a finite threshold (age in milliseconds)");
    if (a.operator === "eq" && !["string", "number", "boolean"].includes(typeof a.value)) throw new Error("Equality needs a string, number, or boolean");
  }
  const recoveryTaskId = typeof r.recoveryTaskId === "string" ? r.recoveryTaskId.trim() : "";
  const evidenceTimestampPath = typeof r.evidenceTimestampPath === "string" ? r.evidenceTimestampPath.trim() : "";
  if (recoveryTaskId || evidenceTimestampPath) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(recoveryTaskId) || !/^\$(?:\.[a-zA-Z0-9_-]+|\[\d+\])+$/.test(evidenceTimestampPath) || evidenceTimestampPath.length > 200 || !assertions.length) throw new Error("Recovery requires a local task ID, completion timestamp path and success assertions");
  }
  return { id, kind: "http", ...(recoveryTaskId ? { recoveryTaskId, evidenceTimestampPath } : {}), name, url: url.href, app: String(r.app ?? "custom").slice(0, 80), enabled: r.enabled !== false,
    intervalMs: integer(r.intervalMs, 60_000, 15_000, 86_400_000, "intervalMs"), timeoutMs: integer(r.timeoutMs, 5000, 500, 30_000, "timeoutMs"),
    failAfter: integer(r.failAfter, 3, 1, 20, "failAfter"), recoverAfter: integer(r.recoverAfter, 2, 1, 20, "recoverAfter"),
    expectedStatus: integer(r.expectedStatus, 200, 200, 599, "expectedStatus"), severity: r.severity === "critical" ? "critical" : "warning", assertions: assertions as Assertion[] };
}
export function field(data: unknown, path: string): unknown {
  const keys = path.slice(1).match(/[a-zA-Z0-9_-]+/g) ?? [];
  let value = data;
  for (const key of keys) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function assertionsResult(data: unknown, assertions: Assertion[], now: number): Pick<Sample, "verdict" | "code" | "detail"> {
  for (const a of assertions) {
    const actual = field(data, a.path);
    if (actual === undefined || actual === null) return { verdict: a.operator === "exists" ? "fail" : "unknown", code: "missing_field", detail: `Missing field: ${a.path}` };
    let pass = false;
    if (a.operator === "exists") pass = true;
    if (a.operator === "eq") pass = actual === a.value;
    if (a.operator === "lt" || a.operator === "gt") {
      if (typeof actual !== "number") return { verdict: "unknown", code: "invalid_type", detail: `${a.path}: expected a number` };
      pass = a.operator === "lt" ? actual < Number(a.value) : actual > Number(a.value);
    }
    if (a.operator === "ageLessThan") {
      if (!validInstant(actual)) return { verdict: "unknown", code: "invalid_timestamp", detail: `${a.path}: expected an ISO timestamp with timezone` };
      const age = now - Date.parse(actual);
      if (age < -60_000) return { verdict: "unknown", code: "clock_skew", detail: `${a.path}: timestamp is in the future` };
      pass = age < Number(a.value);
    }
    if (!pass) return { verdict: "fail", code: "assertion_failed", detail: `${a.path} ${a.operator} ${JSON.stringify(a.value)}: assertion failed (actual: ${JSON.stringify(actual).slice(0, 160)})` };
  }
  return { verdict: "pass", code: "assertions_passed", detail: `${assertions.length} assertions passed` };
}
export function validInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m=value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/);
  if(!m || !Number.isFinite(Date.parse(value)))return false;
  const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]);
  return year>=1000&&month>=1&&month<=12&&day>=1&&day<=new Date(Date.UTC(year,month,0)).getUTCDate()&&Number(m[4])<24&&Number(m[5])<60&&Number(m[6])<60;
}
