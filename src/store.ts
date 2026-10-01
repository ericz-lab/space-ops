import { Database } from "bun:sqlite";
import { DEFAULT_SETTINGS, type Check, type Incident, type Sample, type Settings, type Snapshot, type Rule } from "./types.ts";

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
      const failures = sample.verdict === "fail" ? (prev?.failures ?? 0) + 1 : 0;
      const successes = sample.verdict === "pass" ? (prev?.successes ?? 0) + 1 : 0;
      const incident = this.activeIncident(sample.id);
      let status: Check["status"] = sample.verdict === "unknown" ? "unknown" : sample.verdict === "fail" ? (incident || failures >= (sample.failAfter ?? settings.failAfter) ? "failing" : "pending") : (incident && successes < (sample.recoverAfter ?? settings.recoverAfter) ? "recovering" : "healthy");
      const control = this.get<{ enabled?: boolean; mutedUntil?: string | null }>("control", sample.id);
      if (control?.enabled === false) status = "paused";
      const check: Check = { ...sample, status, failures, successes, observedAt: at, lastPassedAt: sample.verdict === "pass" ? at : prev?.lastPassedAt ?? null, mutedUntil: control?.mutedUntil ?? null, enabled: control?.enabled !== false };
      this.put("check", sample.id, check);
      this.db.query("INSERT INTO observations(check_id,at,verdict,code,latency) VALUES(?,?,?,?,?)").run(sample.id, now, sample.verdict, sample.code, sample.latencyMs ?? null);
      if (status === "failing" && !incident) {
        const i: Incident = { id: crypto.randomUUID(), checkId: sample.id, name: sample.name, app: sample.app, severity: sample.severity ?? "warning", status: "open", openedAt: at, updatedAt: at, resolvedAt: null, detail: sample.detail, events: [{ at, type: "opened", detail: sample.detail }] };
        this.put("incident", i.id, i); this.enqueue(i, "opened", check, now);
      } else if (incident) {
        const changed = incident.detail !== sample.detail;
        incident.updatedAt = at; incident.detail = sample.detail;
        if (status === "healthy") { incident.status = "resolved"; incident.resolvedAt = at; incident.events.push({ at, type: "resolved", detail: sample.detail }); this.enqueue(incident, "resolved", check, now); }
        else if (changed) incident.events.push({ at, type: "observed", detail: sample.detail });
        incident.events = incident.events.slice(-100);
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
  acknowledge(id: string, now = Date.now()) {
    const i = this.get<Incident>("incident", id); if (!i) throw new Error("Incident not found");
    if (i.status === "open") { i.status = "acknowledged"; i.events.push({ at: new Date(now).toISOString(), type: "acknowledged", detail: "Acknowledged by operator" }); this.put("incident", id, i); }
    return i;
  }
  finishScan(now = Date.now()) {
    this.put("meta", "scan", now);
    const cs = this.list<Check>("check");
    this.db.query("INSERT OR REPLACE INTO scans VALUES(?,?,?,?)").run(now, cs.filter(c=>c.status === "healthy").length, cs.filter(c=>["failing","pending","recovering"].includes(c.status)).length, cs.filter(c=>c.status === "unknown").length);
  }
  snapshot(machine: string, now = Date.now()): Snapshot {
    const last = this.get<number>("meta", "scan");
    const checks = this.list<Check>("check").map(c => c.status !== "paused" && now - Date.parse(c.observedAt) > (c.staleAfterMs ?? 180_000) ? { ...c, status: "unknown" as const, code: "stale_observation", detail: "Observation expired; awaiting a fresh probe" } : c);
    const history = (this.db.query("SELECT * FROM scans ORDER BY at DESC LIMIT 48").all() as { at: number; passing: number; failing: number; unknown: number }[]).reverse().map(r => ({ ...r, at: new Date(r.at).toISOString() }));
    return { version: 1, machine, generatedAt: new Date(now).toISOString(), lastScanAt: last ? new Date(last).toISOString() : null, checks, incidents: this.list<Incident>("incident").sort((a,b)=>b.openedAt.localeCompare(a.openedAt)).slice(0,300), history };
  }
  history(id: string) { return (this.db.query("SELECT at,verdict,code,latency FROM observations WHERE check_id=? ORDER BY at DESC LIMIT 60").all(id) as { at: number }[]).map(r=>({ ...r, at: new Date(r.at).toISOString() })); }
  prune(days: number, now = Date.now()) { const before = now - days * 86_400_000; this.db.query("DELETE FROM observations WHERE at<?").run(before); this.db.query("DELETE FROM scans WHERE at<?").run(before); }
}
