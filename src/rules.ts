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
    if (!["exists", "eq", "lt", "gt", "ageLessThan", "dailyBy"].includes(a.operator)) throw new Error("Unsupported assertion operator");
    if (a.operator === "dailyBy" && (typeof a.value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.value))) throw new Error("dailyBy needs a local time such as 15:00");
    if (["lt", "gt", "ageLessThan"].includes(a.operator) && (typeof a.value !== "number" || !Number.isFinite(a.value) || (a.operator === "ageLessThan" && a.value <= 0))) throw new Error("Numeric assertions need a finite threshold (age in milliseconds)");
    if (a.operator === "eq" && !["string", "number", "boolean"].includes(typeof a.value)) throw new Error("Equality needs a string, number, or boolean");
  }
  const recoveryTaskId = typeof r.recoveryTaskId === "string" ? r.recoveryTaskId.trim() : "";
  const evidenceTimestampPath = typeof r.evidenceTimestampPath === "string" ? r.evidenceTimestampPath.trim() : "";
  // The result timestamp makes each distinct execution count once; recovery mapping also needs it.
  if (evidenceTimestampPath && (!/^\$(?:\.[a-zA-Z0-9_-]+|\[\d+\])+$/.test(evidenceTimestampPath) || evidenceTimestampPath.length > 200)) throw new Error("Use a result timestamp path such as $.latest.finishedAt");
  if (recoveryTaskId && (!/^[a-zA-Z0-9-]{1,100}$/.test(recoveryTaskId) || !evidenceTimestampPath || !assertions.length)) throw new Error("Recovery requires a local task ID, result timestamp path and success assertions");
  const timezone = typeof r.timezone === "string" ? r.timezone.trim() : "";
  if (timezone && !validZone(timezone)) throw new Error("Use an IANA timezone such as Asia/Shanghai");
  if (assertions.some((a: Assertion) => a.operator === "dailyBy") && !timezone) throw new Error("dailyBy needs the rule's timezone");
  return { id, kind: "http", ...(timezone ? { timezone } : {}), ...(recoveryTaskId ? { recoveryTaskId } : {}), ...(evidenceTimestampPath ? { evidenceTimestampPath } : {}), name, url: url.href, app: String(r.app ?? "custom").slice(0, 80), enabled: r.enabled !== false,
    intervalMs: integer(r.intervalMs, 300_000, 15_000, 86_400_000, "intervalMs"), timeoutMs: integer(r.timeoutMs, 5000, 500, 30_000, "timeoutMs"),
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
export function validZone(zone: string) { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(zone); } catch { return false; } }
/** Local date and time of an instant in a zone, as `YYYY-MM-DD` and `HH:MM`. */
export function localParts(at: number, zone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** The local date a `dailyBy` deadline currently requires: today once the deadline has passed, otherwise yesterday. */
export function requiredDate(now: number, deadline: string, zone: string) {
  const { date, time } = localParts(now, zone);
  if (time >= deadline) return date;
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}
export function assertionsResult(data: unknown, assertions: Assertion[], now: number, timezone = "UTC"): Pick<Sample, "verdict" | "code" | "detail"> {
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
    if (a.operator === "dailyBy") {
      if (!validInstant(actual)) return { verdict: "unknown", code: "invalid_timestamp", detail: `${a.path}: expected an ISO timestamp with timezone` };
      if (Date.parse(actual) - now > 60_000) return { verdict: "unknown", code: "clock_skew", detail: `${a.path}: timestamp is in the future` };
      const due = requiredDate(now, String(a.value), timezone), got = localParts(Date.parse(actual), timezone).date;
      if (got < due) return { verdict: "fail", code: "daily_deadline_missed", detail: `${a.path}: latest ${got} (${timezone}); ${due} expected by ${a.value}` };
      continue;
    }
    if (a.operator === "today") {
      if (!validInstant(actual)) return { verdict: "unknown", code: "invalid_timestamp", detail: `${a.path}: expected an ISO timestamp with timezone` };
      if (Date.parse(actual) - now > 60_000) return { verdict: "unknown", code: "clock_skew", detail: `${a.path}: timestamp is in the future` };
      const today = localParts(now, timezone).date, got = localParts(Date.parse(actual), timezone).date;
      if (got !== today) return { verdict: "fail", code: "not_today", detail: `${a.path}: latest ${got}, not today ${today} (${timezone})` };
      continue;
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
