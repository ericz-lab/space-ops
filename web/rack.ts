import type { Check, HostResources } from "../src/types.ts";

/** One machine as the machine room draws it: a cabinet whose lights come from the machine's snapshot. */
export type RackMachine = { name: string; local: boolean; fresh: boolean; checks: Check[]; openIncidents: number; resources?: HostResources };
/** `warn`: one-off errors or checks still awaiting evidence. `off`: no fresh snapshot, or nothing measured. */
export type Tone = "ok" | "warn" | "bad" | "off";

const rank: Record<Tone, number> = { bad: 0, warn: 1, ok: 2, off: 3 };
/** A running task is not missing evidence; a paused or unscheduled check has no light. */
function checkTone(c: Check): Tone {
  const s = c.status as string;
  if (s === "failing" || s === "recovering") return "bad";
  if (s === "unknown" && c.code === "task_running") return "ok";
  if (s === "transient" || s === "pending" || s === "unknown") return "warn";
  if (s === "paused" || s === "off") return "off";
  return "ok";
}

/** Stale snapshots are dark, never healthy; failing checks or open incidents are red; one-off or unknown checks are amber. */
export function rackTone(m: RackMachine): Tone {
  if (!m.fresh) return "off";
  const tones = m.checks.map(checkTone);
  if (m.openIncidents || tones.includes("bad")) return "bad";
  if (tones.includes("warn")) return "warn";
  return tones.includes("ok") ? "ok" : "off";
}

/** Spread the checks over the server units, worst first, so the share of red LEDs follows the share of failing checks. */
export function unitTones(m: RackMachine, units: number): Tone[] {
  const tones = m.fresh ? m.checks.map(checkTone).sort((a, b) => rank[a] - rank[b]) : [];
  if (!tones.length) return Array<Tone>(units).fill("off");
  return Array.from({ length: units }, (_, i) => {
    const start = Math.floor(i * tones.length / units), end = Math.max(start + 1, Math.floor((i + 1) * tones.length / units));
    return tones.slice(start, end).sort((a, b) => rank[a] - rank[b])[0]!;
  });
}
