import { Database } from "bun:sqlite";
import { validInstant } from "./rules.ts";
import { DEFAULT_SETTINGS, type Check, type Incident, type Inspection, type IncidentEvent, type Sample, type ScanRecord, type Settings, type Snapshot, type Rule } from "./types.ts";

export class Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY, check_id TEXT NOT NULL, at INTEGER NOT NULL, verdict TEXT NOT NULL, code TEXT NOT NULL, latency REAL);
      CREATE INDEX IF NOT EXISTS observations_check ON observations(check_id,at);
      CREATE TABLE IF NOT EXISTS scans (at INTEGER PRIMARY KEY, passing INTEGER, failing INTEGER, unknown INTEGER);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT);`);
    if (!(this.db.query("PRAGMA table_info(scans)").all() as { name: string }[]).some(c => c.name === "transient")) this.db.exec("ALTER TABLE scans ADD COLUMN transient INTEGER NOT NULL DEFAULT 0");
    if (!(this.db.query("PRAGMA table_info(observations)").all() as { name: string }[]).some(c => c.name === "status")) this.db.exec("ALTER TABLE observations ADD COLUMN status TEXT");
  }
  get<T>(kind: string, id: string): T | null { const r = this.db.query("SELECT body FROM documents WHERE kind=? AND id=?").get(kind, id) as { body: string } | null; return r ? JSON.parse(r.body) as T : null; }
  list<T>(kind: string): T[] { return (this.db.query("SELECT body FROM documents WHERE kind=? ORDER BY id").all(kind) as { body: string }[]).map(r => JSON.parse(r.body) as T); }
  put(kind: string, id: string, data: unknown) { this.db.query("INSERT INTO documents VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").run(kind, id, JSON.stringify(data)); }
  settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.get<Settings>("settings", "main") }; }
  rules(): Rule[] { return this.list<Rule>("rule"); }
  activeIncident(id: string): Incident | undefined { return this.list<Incident>("incident").find(i => i.checkId === id && i.status !== "resolved"); }
  observe(sample: Sample, now = Date.now()): Check {
    return this.db.transaction(() => {
      const settings = this.settings(), at = new Date(now).toISOString();
      const prev = this.get<Check>("check", sample.id);
      // A rule with a result timestamp reports one execution; reading the same failed result again is not another failure.
      const repeat = sample.verdict === "fail" && sample.kind === "http" && !!sample.evidenceAt && prev?.verdict === "fail" && prev.evidenceAt === sample.evidenceAt;
      const failures = sample.verdict === "fail" ? (prev?.failures ?? 0) + (repeat ? 0 : 1) : 0;
      const successes = sample.verdict === "pass" ? (prev?.successes ?? 0) + 1 : 0;
      const incident = this.activeIncident(sample.id);
      let status: Check["status"] = sample.verdict === "unknown" ? (sample.transient && !incident ? "transient" : "unknown") : sample.verdict === "fail" ? (incident || failures >= (sample.failAfter ?? settings.failAfter) ? "failing" : "transient") : (incident && successes < (sample.recoverAfter ?? settings.recoverAfter) ? "recovering" : "healthy");
      const control = this.get<{ enabled?: boolean; mutedUntil?: string | null }>("control", sample.id);
      if (control?.enabled === false) status = "paused";
      // When the current failure episode began; a task reports the end of its failed execution instead.
      const failed = sample.verdict === "fail" || status === "transient", wasFailed = prev?.verdict === "fail" || prev?.status === "transient";
      const failedAt = !failed ? prev?.failedAt ?? null : sample.kind === "task" && validInstant(sample.evidenceAt) ? sample.evidenceAt : wasFailed && prev?.failedAt ? prev.failedAt : at;
      const check: Check = { ...sample, status, failures, successes, observedAt: at, lastPassedAt: sample.verdict === "pass" ? at : prev?.lastPassedAt ?? null, failedAt, mutedUntil: control?.mutedUntil ?? null, enabled: control?.enabled !== false };
      this.put("check", sample.id, check);
      this.db.query("INSERT INTO observations(check_id,at,verdict,code,latency,status) VALUES(?,?,?,?,?,?)").run(sample.id, now, sample.verdict, sample.code, sample.latencyMs ?? null, status);
      if (status === "failing" && !incident) {
        const i: Incident = { id: crypto.randomUUID(), checkId: sample.id, name: sample.name, app: sample.app, severity: sample.severity ?? "warning", status: "open", openedAt: at, updatedAt: at, resolvedAt: null, detail: sample.detail, source: "auto", events: [{ at, type: "opened", detail: sample.detail }] };
        this.put("incident", i.id, i); this.enqueue(i, "opened", check, now);
      } else if (incident) {
        const changed = incident.detail !== sample.detail;
        incident.updatedAt = at; incident.detail = sample.detail;
        // An operator's incident stays open until an operator resolves it; the check recovering is recorded on it.
        if (status === "healthy" && incident.source === "manual") { if (incident.events.at(-1)?.type !== "recovered") incident.events.push({ at, type: "recovered", detail: sample.detail }); }
        else if (status === "healthy") { incident.status = "resolved"; incident.resolvedAt = at; incident.resolvedBy = "check"; incident.events.push({ at, type: "resolved", detail: sample.detail }); this.enqueue(incident, "resolved", check, now); }
        else if (changed || incident.events.at(-1)?.type === "recovered") incident.events.push({ at, type: "observed", detail: sample.detail });
        incident.events = trimEvents(incident.events);
        this.put("incident", incident.id, incident);
      }
      return check;
    })();
  }
  enqueue(i: Incident, type: string, c: Check, now: number) {
    if (!this.settings().notifications || (c.mutedUntil && Date.parse(c.mutedUntil) > now)) return;
    const id = `${i.id}:${type}`;
    this.db.query("INSERT OR IGNORE INTO outbox(id,body,next_at) VALUES(?,?,?)").run(id, JSON.stringify({ title: `${type === "resolved" ? "Recovered" : "Incident"}: ${i.name}`, text: i.detail, level: type === "resolved" ? "success" : "error", key: id }), now);
  }
  control(id: string, patch: { enabled?: boolean; mutedUntil?: string | null }, now = Date.now()) {
    const c = this.get<Check>("check", id); if (!c) throw new Error("Check not found");
    const next = { ...this.get<object>("control", id), ...patch };
    this.put("control", id, next);
    if (patch.enabled !== undefined) { c.enabled = patch.enabled; c.status = patch.enabled ? "unknown" : "paused"; c.failures = 0; c.successes = 0; }
    if (patch.mutedUntil !== undefined) c.mutedUntil = patch.mutedUntil;
    this.put("check", id, c);
    const i = this.activeIncident(id); if (i) { i.events.push({ at: new Date(now).toISOString(), type: patch.enabled === false ? "paused" : "configuration", detail: JSON.stringify(patch) }); this.put("incident", i.id, i); }
  }
  acknowledge(id: string, now = Date.now(), by?: string) {
    const i = this.get<Incident>("incident", id); if (!i) throw new Error("Incident not found");
    if (i.status === "open") { i.status = "acknowledged"; i.events.push({ at: new Date(now).toISOString(), type: "acknowledged", detail: "Acknowledged by operator", ...(by ? { by } : {}) }); this.put("incident", id, i); }
    return i;
  }
  incident(id: string): Incident { const i = this.get<Incident>("incident", id); if (!i) throw new Error("Incident not found"); return i; }
  /** An operator's incident, for a check (one open incident per check) or for something no check covers. */
  createIncident(input: { checkId?: string; name?: string; app?: string; detail: string; severity?: Incident["severity"]; by?: string }, now = Date.now()): Incident {
    return this.db.transaction(() => {
      const at = new Date(now).toISOString(), check = input.checkId ? this.get<Check>("check", input.checkId) : null;
      if (input.checkId && !check) throw new Error("Check not found");
      if (check && this.activeIncident(check.id)) throw new Error("An incident is already open for this check");
      const name = input.name || check?.name; if (!name) throw new Error("Name required");
      const i: Incident = { id: crypto.randomUUID(), checkId: check?.id ?? `manual:${crypto.randomUUID()}`, name, app: input.app || check?.app || "custom", severity: input.severity ?? check?.severity ?? "warning", status: "open", openedAt: at, updatedAt: at, resolvedAt: null, detail: input.detail || check?.detail || name, source: "manual", events: [{ at, type: "created", detail: input.detail || check?.detail || name, ...(input.by ? { by: input.by } : {}) }] };
      this.put("incident", i.id, i);
      if (check) this.enqueue(i, "opened", check, now);
      return i;
    })();
  }
  /** A repair record: what was found or done. */
  note(id: string, text: string, by?: string, now = Date.now()): Incident {
    const i = this.incident(id), at = new Date(now).toISOString();
    i.events = trimEvents([...i.events, { at, type: "note", detail: text, ...(by ? { by } : {}) }]); i.updatedAt = at;
    this.put("incident", id, i); return i;
  }
  /** Closed by an operator. A check still failing has to fail again `failAfter` times to open a new incident. */
  resolve(id: string, text: string, by?: string, now = Date.now()): Incident {
    return this.db.transaction(() => {
      const i = this.incident(id), at = new Date(now).toISOString();
      if (i.status === "resolved") throw new Error("Incident is already resolved");
      i.status = "resolved"; i.resolvedAt = at; i.updatedAt = at; i.resolvedBy = by || "operator";
      i.events = trimEvents([...i.events, { at, type: "resolved", detail: text || "Resolved by operator", by: by || "operator" }]);
      this.put("incident", id, i);
      const c = this.get<Check>("check", i.checkId);
      if (c) { c.failures = 0; if (c.status === "failing") c.status = "transient"; else if (c.status === "recovering") c.status = "healthy"; this.put("check", c.id, c); this.enqueue(i, "resolved", c, now); }
      return i;
    })();
  }
  /** What failed in the scan finished at `at`: each check's last non-passing observation since the previous scan. */
  scanRecord(at: number): ScanRecord | null {
    const scan = this.db.query("SELECT at FROM scans WHERE at=?").get(at) as { at: number } | null; if (!scan) return null;
    const prev = this.db.query("SELECT MAX(at) AS at FROM scans WHERE at<?").get(at) as { at: number | null };
    const from = prev.at ?? at - 3_600_000;
    const rows = this.db.query("SELECT check_id,MAX(at) AS at,verdict,code,status FROM observations WHERE at>? AND at<=? AND (status IN ('failing','transient','recovering') OR (status IS NULL AND verdict='fail')) GROUP BY check_id ORDER BY at").all(from, at) as { check_id: string; at: number; verdict: string; code: string; status: string | null }[];
    const checks = rows.map(r => { const c = this.get<Check>("check", r.check_id); return { id: r.check_id, name: c?.name ?? r.check_id, app: c?.app ?? "", kind: c?.kind ?? "", status: r.status ?? "failing", verdict: r.verdict, code: r.code, at: new Date(r.at).toISOString() }; });
    return { at: new Date(at).toISOString(), previousAt: prev.at ? new Date(prev.at).toISOString() : null, checks };
  }
  finishScan(now = Date.now()) {
    this.put("meta", "scan", now);
    const cs = this.list<Check>("check");
    this.db.query("INSERT OR REPLACE INTO scans(at,passing,failing,unknown,transient) VALUES(?,?,?,?,?)").run(now, cs.filter(c=>c.status === "healthy").length, cs.filter(c=>["failing","recovering"].includes(c.status)).length, cs.filter(c=>c.status === "unknown").length, cs.filter(c=>c.status === "transient").length);
  }
  snapshot(machine: string, now = Date.now(), staleAfterMs = 240_000): Snapshot {
    const last = this.get<number>("meta", "scan");
    const checks = this.list<Check>("check").map(c => c.status !== "paused" && now - Date.parse(c.observedAt) > (c.staleAfterMs ?? 180_000) ? { ...c, status: "unknown" as const, code: "stale_observation", detail: "Observation expired; awaiting a fresh probe" } : c);
    const history = (this.db.query("SELECT * FROM scans ORDER BY at DESC LIMIT 48").all() as { at: number; passing: number; failing: number; unknown: number; transient: number }[]).reverse().map(r => ({ ...r, at: new Date(r.at).toISOString() }));
    const all=this.list<Incident>("incident").sort((a,b)=>b.openedAt.localeCompare(a.openedAt));
    const incidents=[...all.filter(i=>i.status!=="resolved"),...all.filter(i=>i.status==="resolved").slice(0,100)];
    // A reading older than the scan lease is no longer today's answer.
    const inspections = this.list<Inspection>("inspection").map(i => now - Date.parse(i.observedAt) > staleAfterMs ? { ...i, state: "unknown" as const, detail: "Reading expired; awaiting a fresh scan" } : i);
    return { version: 1, machine, generatedAt: new Date(now).toISOString(), lastScanAt: last ? new Date(last).toISOString() : null, staleAfterMs, checks, incidents, history, inspections };
  }
  /** One inspection reading; `doneAt` remembers the last reading that was done. */
  putInspection(reading: Omit<Inspection, "doneAt">) {
    const prev = this.get<Inspection>("inspection", reading.id);
    this.put("inspection", reading.id, { ...reading, doneAt: reading.state === "done" ? reading.observedAt : prev?.doneAt ?? null } satisfies Inspection);
  }
  /** Forget checks no app declares any more. */
  retainInspections(ids: string[]) {
    const keep = new Set(ids);
    for (const i of this.list<Inspection>("inspection")) if (!keep.has(i.id)) this.db.query("DELETE FROM documents WHERE kind='inspection' AND id=?").run(i.id);
  }
  history(id: string) { return (this.db.query("SELECT at,verdict,code,latency FROM observations WHERE check_id=? ORDER BY at DESC LIMIT 60").all(id) as { at: number }[]).map(r=>({ ...r, at: new Date(r.at).toISOString() })); }
  prune(days: number, now = Date.now()) { const before = now - days * 86_400_000; this.db.query("DELETE FROM observations WHERE at<?").run(before); this.db.query("DELETE FROM scans WHERE at<?").run(before); }
}

/** At most 100 events; the opening event and operator records (notes, resolution) are never dropped. */
export function trimEvents(events: IncidentEvent[]): IncidentEvent[] {
  if (events.length <= 100) return events;
  const keep = (e: IncidentEvent, i: number) => i === 0 || ["note", "created", "resolved", "acknowledged"].includes(e.type);
  const pinned = events.filter(keep).length, room = Math.max(0, 100 - pinned);
  let rest = events.filter((e, i) => !keep(e, i)).length - room;
  return events.filter((e, i) => keep(e, i) || rest-- <= 0);
}
