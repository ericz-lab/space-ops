import { readJson } from "./probes.ts";
import { assertionsResult, localParts } from "./rules.ts";
import type { DeclaredCheck, Inspection, InspectionState } from "./types.ts";

/**
 * Inspection (点检) of the checks apps declare in space.yaml. A check says whether today's work is
 * there; it is read every scan and shown on its own page, and never opens an incident or notifies:
 * not being done yet is usually just "not time yet".
 */
export function evaluate(c: DeclaredCheck, data: unknown, now: number): { state: InspectionState; detail: string } {
  const zone = c.timezone ?? "UTC";
  if (c.when?.length) {
    const w = assertionsResult(data, c.when, now, zone);
    if (w.verdict === "unknown") return { state: "unknown", detail: w.detail };
    if (w.verdict === "fail") return { state: "off", detail: w.detail };
  }
  const d = assertionsResult(data, c.done, now, zone);
  if (d.verdict === "pass") return { state: "done", detail: d.detail };
  if (d.verdict === "unknown") return { state: "unknown", detail: d.detail };
  return { state: c.due && localParts(now, zone).time < c.due ? "pending" : "late", detail: d.detail };
}

/** Read one declared check: GET on the app's loopback URL, bounded and without redirects. */
export async function inspect(c: DeclaredCheck, fetcher: typeof fetch, now = Date.now()): Promise<Omit<Inspection, "doneAt">> {
  const { url: _url, done: _done, when: _when, ...base } = c;
  const at = new Date(now).toISOString(), started = performance.now();
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(c.url)) return { ...base, state: "unknown", detail: "Declared check URL is not on this machine's loopback", observedAt: at };
  try {
    const data = await readJson(c.url, 8000, fetcher);
    return { ...base, ...evaluate(c, data, now), observedAt: at, latencyMs: Math.round(performance.now() - started) };
  } catch (e) {
    return { ...base, state: "unknown", detail: `Check endpoint is unavailable or returned invalid JSON (${e instanceof Error ? e.message.slice(0, 120) : "error"})`, observedAt: at };
  }
}

/** Space's /api/checks payload, keeping only well-formed entries. */
export function declared(raw: unknown): DeclaredCheck[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { checks?: unknown }).checks)) throw new Error("Invalid checks response");
  return ((raw as { checks: unknown[] }).checks).filter((c): c is DeclaredCheck => !!c && typeof c === "object" && typeof (c as DeclaredCheck).id === "string" && typeof (c as DeclaredCheck).url === "string" && Array.isArray((c as DeclaredCheck).done)).slice(0, 200);
}
