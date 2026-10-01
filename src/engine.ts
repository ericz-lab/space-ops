import { Store } from "./store.ts";
import { hostSamples, httpProbe, readJson, taskSample, type Task } from "./probes.ts";
import type { Check, PeerView, Sample, Snapshot } from "./types.ts";

export class Engine {
  private running: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  constructor(readonly store: Store, readonly config: { api: string; machine: string; dataDir: string; intervalMs: number; retentionDays: number; appToken?: string; peers?: { name: string; url: string }[] }, private fetcher: typeof fetch = fetch) {}
  start() { this.stopped = false; const tick = async () => { try { await this.scan(); } catch (e) { console.error("[ops] scan failed", e instanceof Error ? e.message : "unknown"); } if (!this.stopped) this.timer = setTimeout(tick, this.config.intervalMs); }; void tick(); }
  stop() { this.stopped = true; clearTimeout(this.timer); }
  scan(): Promise<void> { if (this.running) return this.running; this.running = this.collect().finally(()=>{this.running=null;}); return this.running; }
  busy() { return !!this.running; }
  snapshot() { return this.store.snapshot(this.config.machine,Date.now(),Math.max(240_000,this.config.intervalMs*4)); }
  private async collect() {
    const settings = this.store.settings(), now = Date.now();
    const seen = new Set<string>();
    const observe = (s: Sample) => { seen.add(s.id); this.store.observe({ staleAfterMs: this.config.intervalMs*3+60_000, ...s }); };
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
        await pool(tasks, 4, async t => {
          let s = taskSample(t,settings,now);
          if (t.state.lastStatus === "skipped") {
            try { const r = await get(`/api/tasks/${encodeURIComponent(t.id)}/runs?limit=3`); if (Array.isArray(r.runs) && r.runs.length === 3 && r.runs.every((v:{status:string})=>v.status === "skipped")) s = { ...s,verdict:"fail",code:"task_repeated_skip",detail:"Three consecutive executions were skipped" }; } catch { /* Keep the unknown result when history is unavailable. */ }
          }
          observe(s);
        });
      }),
      source("peers", async () => {
        const d = await get("/api/peers"); if (!Array.isArray(d.peers)) throw new Error("Invalid peers response");
        const peers: { name:string; url:string }[] = d.peers.map((p:{name:string})=>({name:p.name,url:`${this.config.api}/api/peers/${encodeURIComponent(p.name)}/apps/space-ops/proxy/api/snapshot`}));
        for (const peer of this.config.peers ?? []) if (!peers.some(p=>p.name===peer.name)) peers.push(peer);
        await pool(peers, 3, async p => {
          const prev = this.store.get<PeerView>("peer",p.name);
          try {
            const snap = await readJson(p.url,10000,this.fetcher) as Snapshot;
            if (snap.version !== 1 || !Array.isArray(snap.checks) || !Array.isArray(snap.incidents) || typeof snap.machine !== "string" || !Number.isFinite(Date.parse(snap.generatedAt))) throw new Error("Invalid snapshot");
            const lease=Number.isFinite(snap.staleAfterMs)&&snap.staleAfterMs>=60_000&&snap.staleAfterMs<=14_400_000?snap.staleAfterMs:240_000;
            if (!snap.lastScanAt || !Number.isFinite(Date.parse(snap.lastScanAt)) || now-Date.parse(snap.lastScanAt)>lease || Date.parse(snap.lastScanAt)>now+60_000) throw new Error("Peer scan expired or clock differs");
            this.store.put("peer",p.name,{name:p.name,status:"healthy",snapshot:snap,receivedAt:new Date().toISOString()} satisfies PeerView);
            observe({id:`peer:${p.name}`,name:p.name,app:"peers",kind:"peer",coverage:"availability",verdict:"pass",code:"peer_ok",detail:"Peer collector is reporting fresh observations"});
          } catch {
            this.store.put("peer",p.name,{name:p.name,status:"unknown",error:"Peer collector is unavailable or its snapshot expired",snapshot:prev?.snapshot??null,receivedAt:prev?.receivedAt??null} satisfies PeerView);
            observe({id:`peer:${p.name}`,name:p.name,app:"peers",kind:"peer",coverage:"availability",verdict:"fail",code:"peer_unavailable",detail:"Peer collector is unavailable or its snapshot expired"});
          }
        });
      }),
      hostSamples(this.config.dataDir,settings).then(samples=>samples.forEach(observe)),
      pool(this.store.rules(),4,async rule=>{
        seen.add(rule.id);
        const control = this.store.get<{enabled?:boolean}>("control",rule.id);
        if (!rule.enabled || control?.enabled === false) return;
        const last = this.store.get<Check>("check",rule.id);
        if (last && now-Date.parse(last.observedAt)<rule.intervalMs && last.status !== "unknown") return;
        observe(await httpProbe(rule,this.fetcher));
      })
    ]);
    for (const check of this.store.list<Check>("check")) {
      if (seen.has(check.id) || check.status === "paused") continue;
      observe({...check,verdict:"unknown",code:"not_observed",detail:"Resource is absent, disabled, or its discovery source is unavailable"});
    }
    this.store.finishScan(); this.store.prune(this.config.retentionDays);
    await this.deliver();
  }
  peers(now=Date.now()): PeerView[] { return this.store.list<PeerView>("peer").map(p=>p.receivedAt && now-Date.parse(p.receivedAt)<=Math.max(240_000,this.config.intervalMs*4) ? p : {...p,status:"unknown",error:"Peer snapshot expired"}); }
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
async function pool<T>(items:T[], concurrency:number, fn:(item:T)=>Promise<void>) { let index=0; await Promise.all(Array.from({length:Math.min(items.length,concurrency)},async()=>{while(index<items.length){const item=items[index++]!;await fn(item);}})); }
