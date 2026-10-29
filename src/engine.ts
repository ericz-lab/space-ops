import { ruleActive, pendingDeadline } from "./rules.ts";
import { Store } from "./store.ts";
import { declared, inspect } from "./inspections.ts";
import { declaredNoop, hostSamples, httpProbe, readHostResources, readJson, repeatedSkip, taskSample, withRecoveryEvidence, type CpuTicks, type Task } from "./probes.ts";
import type { Check, PeerView, Sample, Snapshot, TaskPolicy } from "./types.ts";

export class Engine {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;
  private tickAt = 0;
  /** CPU counters of the previous scan: the next scan's CPU percentage covers the interval between them. */
  private cpuTicks: CpuTicks | null = null;
  /** `cpuSettleMs`: on the first scan, wait this long between two CPU samples so the number exists at once (0 = wait for the next scan). */
  constructor(readonly store: Store, readonly config: { api: string; machine: string; dataDir: string; retentionDays: number; appToken?: string; peers?: { name: string; url: string }[]; cpuSettleMs?: number }, readonly fetcher: typeof fetch = fetch) {}
  /** Scan cadence from Settings, so the operator changes it without a restart. */
  intervalMs() { return this.store.settings().scanMinutes * 60_000; }
  /** How long a scan stays current: four cadences, never under four minutes. */
  leaseMs() { return Math.max(240_000, this.intervalMs() * 4); }
  nextScanAt() { return this.stopped || !this.tickAt ? null : new Date(this.tickAt + this.intervalMs()).toISOString(); }
  start() { this.stopped = false; void this.tick(); }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  /** Re-arm the timer after a cadence change; the next scan is due one new interval after the last one started. */
  reschedule() { if (this.stopped) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.tick(), Math.max(1000, this.tickAt + this.intervalMs() - Date.now())); }
  private async tick() { this.tickAt = Date.now(); try { await this.scan(); } catch (e) { console.error("[ops] scan failed", e instanceof Error ? e.message : "unknown"); } this.reschedule(); }
  scan(): Promise<void> { if (this.running) return this.running; this.running = this.collect().finally(()=>{this.running=null;}); return this.running; }
  busy() { return !!this.running; }
  snapshot() { return this.store.snapshot(this.config.machine,Date.now(),this.leaseMs()); }
  private async collect() {
    const settings = this.store.settings(), now = Date.now(), cadence = settings.scanMinutes * 60_000;
    const seen = new Set<string>();
    const taskSamples: Sample[] = [];
    const observe = (s: Sample) => { seen.add(s.id); this.store.observe({ staleAfterMs: cadence*3+60_000, ...s }); };
    const get = (path: string) => readJson(this.config.api + path, 8000, this.fetcher);
    const source = async (name: string, work: ()=>Promise<void>) => {
      try { await work(); observe({ id:`source:${name}`, name:`Space ${name}`, app:"space",kind:"space",coverage:"availability",verdict:"pass",code:"source_ok",detail:"Source responded with valid data" }); }
      catch { observe({ id:`source:${name}`, name:`Space ${name}`,app:"space",kind:"space",coverage:"availability",verdict:"fail",code:"source_unavailable",detail:"Source is unavailable or returned an invalid response" }); }
    };
    await Promise.all([
      source("services", async () => {
        const d = await get("/api/services"); if (!Array.isArray(d.services)) throw new Error("Invalid services response");
        for (const s of d.services) { if (s.peer || s.app === "space-ops" || s.status !== "active") continue;
          observe({ id:`service:${s.app}`, name:s.title || s.app, app:s.app,kind:"service",coverage:"availability",verdict:s.health === "ok" ? "pass" : s.health === "down" ? "fail" : "unknown", code:`service_${s.health}`,detail:"Space service health probe; business output is not verified" });
        }
      }),
      source("tasks", async () => {
        const d = await get("/api/tasks"); if (!Array.isArray(d.tasks)) throw new Error("Invalid tasks response");
        const tasks = (d.tasks as Task[]).filter(t=>t.enabled && !t.orphaned);
        // The list answered: a task check whose task is gone, orphaned or disabled is retired, not left unknown forever.
        const live = new Set(tasks.map(t=>`task:${t.id}`));
        for (const c of this.store.list<Check>("check")) if (c.kind === "task" && !live.has(c.id)) this.store.retire(c.id,"Task is no longer declared or is disabled; check retired",now);
        await pool(tasks, 4, async t => {
          let s = taskSample(t,settings,now,this.store.get<TaskPolicy>("taskPolicy",t.id) ?? {});
          if (t.state.lastStatus === "skipped") {
            try { const r = await get(`/api/tasks/${encodeURIComponent(t.id)}/runs?limit=50`); const noop = Array.isArray(r.runs) && r.runs[0] ? declaredNoop(r.runs[0]) : undefined;
              if (noop) s = { ...s,verdict:"pass",transient:undefined,failAfter:undefined,code:"task_noop",detail:`Latest execution was skipped by design (${noop})` };
              else if (Array.isArray(r.runs) && repeatedSkip(r.runs,now)) s = { ...s,verdict:"fail",transient:false,code:"task_repeated_skip",detail:"Three consecutive executions were skipped and none succeeded in 24 hours" }; } catch { /* Keep the unknown result when history is unavailable. */ }
          }
          taskSamples.push(s);
        });
      }),
      source("peers", async () => {
        const d = await get("/api/peers"); if (!Array.isArray(d.peers)) throw new Error("Invalid peers response");
        const peers: { name:string; url:string }[] = d.peers.map((p:{name:string})=>({name:p.name,url:`${this.config.api}/api/peers/${encodeURIComponent(p.name)}/apps/space-ops/proxy/api/snapshot`}));
        for (const peer of this.config.peers ?? []) if (!peers.some(p=>p.name===peer.name)) peers.push(peer);
        // Read every listed peer first: a newly named peer's snapshot says whether it is a known machine renamed.
        const known = this.store.list<PeerView>("peer"), read = new Map<string, Snapshot>();
        await pool(peers, 3, async p => {
          try {
            const snap = await readJson(p.url,10000,this.fetcher) as Snapshot;
            if (snap.version !== 1 || !Array.isArray(snap.checks) || !Array.isArray(snap.incidents) || typeof snap.machine !== "string" || !Number.isFinite(Date.parse(snap.generatedAt))) throw new Error("Invalid snapshot");
            const lease=Number.isFinite(snap.staleAfterMs)&&snap.staleAfterMs>=60_000&&snap.staleAfterMs<=14_400_000?snap.staleAfterMs:240_000;
            if (!snap.lastScanAt || !Number.isFinite(Date.parse(snap.lastScanAt)) || now-Date.parse(snap.lastScanAt)>lease || Date.parse(snap.lastScanAt)>now+60_000) throw new Error("Peer scan expired or clock differs");
            read.set(p.name, snap);
          } catch { /* Recorded below as unavailable. */ }
        });
        // The list answered, so a peer it no longer names was renamed or removed: a rename carries the machine's data over, a removal retires it.
        // A rename can only land on a peer never read before (`fresh`): one already read is a machine of its own.
        const live = new Set(peers.map(p=>p.name)), gone = known.filter(k=>!live.has(k.name)), fresh = peers.filter(p=>!known.some(k=>k.name===p.name&&k.snapshot));
        for (const [from, to] of renames(gone, fresh.flatMap(p=>{const snap=read.get(p.name);return snap?[{name:p.name,snapshot:snap}]:[];}))) this.store.renamePeer(from, to, now, `Peer renamed from ${from} to ${to} (same Space Ops collector)`);
        // A newly named peer not read yet may be one of them: wait for it, a day at most, before retiring.
        const unread = fresh.some(p=>!read.has(p.name));
        for (const old of gone) {
          if (!this.store.get<PeerView>("peer",old.name)) continue;
          const since = old.missingSince ?? new Date(now).toISOString();
          if (unread && now-Date.parse(since) < RENAME_WAIT_MS) { this.store.put("peer",old.name,{...old,missingSince:since} satisfies PeerView); seen.add(`peer:${old.name}`); continue; }
          this.store.drop("peer",old.name); this.store.retire(`peer:${old.name}`,"Peer is no longer configured; check retired",now);
        }
        for (const p of peers) {
          const prev = this.store.get<PeerView>("peer",p.name), snap = read.get(p.name);
          if (snap) {
            this.store.put("peer",p.name,{name:p.name,url:p.url,status:"healthy",snapshot:snap,receivedAt:new Date().toISOString()} satisfies PeerView);
            observe({id:`peer:${p.name}`,name:p.name,app:"peers",kind:"peer",coverage:"availability",verdict:"pass",code:"peer_ok",detail:"Peer collector is reporting fresh observations"});
          } else {
            this.store.put("peer",p.name,{name:p.name,url:p.url,status:"unknown",error:"Peer collector is unavailable or its snapshot expired",snapshot:prev?.snapshot??null,receivedAt:prev?.receivedAt??null} satisfies PeerView);
            observe({id:`peer:${p.name}`,name:p.name,app:"peers",kind:"peer",coverage:"availability",verdict:"fail",code:"peer_unavailable",detail:"Peer collector is unavailable or its snapshot expired"});
          }
        }
      }),
      // Apps' declared checks (点检): read for the inspection page, never observed as faults.
      source("checks", async () => {
        const list = declared(await get("/api/checks"));
        await pool(list, 4, async c => this.store.putInspection(await inspect(c, this.fetcher, now)));
        this.store.retainInspections(list.map(c => c.id));
      }),
      readHostResources(this.config.dataDir,this.cpuTicks,this.config.cpuSettleMs??0,now).then(({resources,ticks})=>{ this.cpuTicks=ticks; this.store.put("meta","resources",resources); hostSamples(resources,settings).forEach(observe); }),
      pool(this.store.rules(),4,async rule=>{
        seen.add(rule.id);
        const control = this.store.get<{enabled?:boolean}>("control",rule.id);
        if (!rule.enabled || control?.enabled === false) return;
        const last = this.store.get<Check>("check",rule.id);
        const waiting = ruleActive(rule, now) ? (pendingDeadline(rule.assertions, now, rule.timezone) ? "rule_before_deadline" : undefined) : "rule_offday";
        if (last && now-Date.parse(last.observedAt)<rule.intervalMs && last.status !== "unknown" && (["rule_offday", "rule_before_deadline"].includes(last.code) ? last.code : undefined) === waiting) return;
        // A rule shorter than the scan cadence runs once per scan, so it expires on the cadence.
        observe({ ...await httpProbe(rule,this.fetcher,now), staleAfterMs: Math.max(rule.intervalMs,cadence)*3+rule.timeoutMs });
      })
    ]);
    for (const sample of taskSamples) observe(withRecoveryEvidence(sample, this.store.rules(), this.store.list<Check>("check"), now));
    for (const check of this.store.list<Check>("check")) {
      if (seen.has(check.id) || check.status === "paused") continue;
      observe({...check,verdict:"unknown",transient:false,code:"not_observed",detail:"Resource is absent, disabled, or its discovery source is unavailable"});
    }
    this.store.finishScan(); this.store.prune(this.config.retentionDays);
    await this.deliver();
  }
  peers(now=Date.now()): PeerView[] { return this.store.list<PeerView>("peer").filter(p=>!p.missingSince).map(p=>p.receivedAt && now-Date.parse(p.receivedAt)<=this.leaseMs() ? p : {...p,status:"unknown",error:"Peer snapshot expired"}); }
  async deliver() {
    if (!this.store.settings().notifications || !this.config.appToken) return;
    const rows = this.store.db.query("SELECT * FROM outbox WHERE next_at<=? AND attempts<10 ORDER BY next_at LIMIT 5").all(Date.now()) as {id:string;body:string;attempts:number}[];
    for (const r of rows) {
      try {
        const response = await this.fetcher(`${this.config.api}/api/notify`, { method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${this.config.appToken}`},body:r.body,signal:AbortSignal.timeout(5000) });
        const d = await response.json() as {ok?:boolean};
        if (!response.ok || !d.ok) throw new Error("Notification service rejected request");
        this.store.db.query("DELETE FROM outbox WHERE id=?").run(r.id);
      } catch {
        this.store.db.query("UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE id=?").run(Date.now()+Math.min(3600_000,60_000*2**r.attempts),"Notification delivery failed",r.id);
      }
    }
  }
}
/** How long a peer the Space list stopped naming waits for an unread new peer to say whether it is the same machine. */
export const RENAME_WAIT_MS = 86_400_000;
/**
 * Which gone peers reappear under a new name. The same machine is told by its Space Ops collector id; a
 * collector too old to report one is matched by the name the machine calls itself (SPACE_NAME), and only
 * when exactly one gone and one new peer share it. Anything else is not a rename.
 */
export function renames(gone: { name: string; snapshot: Snapshot | null }[], fresh: { name: string; snapshot: Snapshot }[]): [string, string][] {
  const out: [string, string][] = [], taken = new Set<string>();
  for (const n of fresh) {
    const byId = n.snapshot.collector ? gone.filter(g => g.snapshot?.collector === n.snapshot.collector) : [];
    const bySelf = gone.filter(g => g.snapshot && !(g.snapshot.collector && n.snapshot.collector) && g.snapshot.machine === n.snapshot.machine);
    const twins = fresh.filter(f => f.snapshot.machine === n.snapshot.machine && !(f.snapshot.collector && n.snapshot.collector && f.snapshot.collector !== n.snapshot.collector));
    const match = byId.length === 1 ? byId[0] : !byId.length && bySelf.length === 1 && twins.length === 1 ? bySelf[0] : undefined;
    if (match && !taken.has(match.name)) { taken.add(match.name); out.push([match.name, n.name]); }
  }
  return out;
}
async function pool<T>(items:T[], concurrency:number, fn:(item:T)=>Promise<void>) { let index=0; await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{while(index<items.length){const item=items[index++]!;await fn(item);}})); }
