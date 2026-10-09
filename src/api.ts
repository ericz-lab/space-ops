import { validateRule } from "./rules.ts";
import type { Engine } from "./engine.ts";
import type { Diagnosis } from "./diagnose.ts";
import type { Check, Settings, Snapshot, TaskPolicy } from "./types.ts";

export function api(engine: Engine, diagnosis?: Diagnosis) {
  const store = engine.store;
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url), path = url.pathname;
    const json = (data:unknown,status=200)=>Response.json(data,{status,headers:{"cache-control":"no-store","x-content-type-options":"nosniff"}});
    try {
      if (!["GET","HEAD"].includes(req.method)) {
        // Require a browser same-origin JSON request; no ambient cross-site writes.
        let origin: URL;
        try { origin=new URL(req.headers.get("origin")??""); } catch { return json({ok:false,error:"Same-origin requests required"},403); }
        // TLS terminates at the trusted Space ingress. Preserve host/port matching
        // without assuming that the loopback request still has an HTTPS scheme.
        if (!["http:","https:"].includes(origin.protocol) || origin.host !== url.host || req.headers.get("sec-fetch-site") === "cross-site") return json({ok:false,error:"Same-origin requests required"},403);
        if (!(req.headers.get("content-type")??"").startsWith("application/json")) return json({ok:false,error:"JSON required"},415);
        if (Number(req.headers.get("content-length")??0)>32768) return json({ok:false,error:"Request too large"},413);
      }
      const body = async()=>{const text=await req.text(); if(text.length>32768) throw new Error("Request too large"); return JSON.parse(text);};
      if (path === "/healthz") { const last=store.get<number>("meta","scan"); const ok=!!last && Date.now()-last<engine.leaseMs(); return json({ok,lastScanAt:last?new Date(last).toISOString():null},ok?200:503); }
      if (req.method === "GET" && path === "/api/snapshot") return json(engine.snapshot());
      if (req.method === "GET" && path === "/api/dashboard") return json({ok:true,local:engine.snapshot(),peers:engine.peers(),rules:store.rules(),settings:store.settings(),taskPolicies:Object.fromEntries((store.db.query("SELECT id,body FROM documents WHERE kind='taskPolicy'").all() as {id:string;body:string}[]).map(r=>[r.id,JSON.parse(r.body)])),busy:engine.busy(),reports:store.reports(),diagnosisReady:!!diagnosis?.ready(),scan:{intervalMs:engine.intervalMs(),nextAt:engine.nextScanAt()},notificationQueue:store.db.query("SELECT COUNT(*) AS pending,SUM(CASE WHEN attempts>=10 THEN 1 ELSE 0 END) AS failed FROM outbox").get(),notificationReady:!!engine.config.appToken});
      if (req.method === "GET" && path === "/api/widget") return json(widget(engine.snapshot()));
      if (req.method === "GET" && path.startsWith("/api/checks/")) { const id=decodeURIComponent(path.slice(12)); return json({ok:true,check:store.get<Check>("check",id),history:store.history(id)}); }
      // This machine only, never its peers: a hub reads it through the Space peer proxy, so evidence does not fan out.
      if (req.method === "GET" && path === "/api/evidence") { if(!diagnosis)return json({ok:false,error:"Diagnosis is unavailable"},503); return json({ok:true,version:1,...await diagnosis.evidence()}); }
      if (req.method === "GET" && path === "/api/reports") return json({ok:true,reports:store.reports(100)});
      if (req.method === "GET" && path.startsWith("/api/reports/")) { const r=store.report(decodeURIComponent(path.slice(13))); return r?json({ok:true,report:r}):json({ok:false,error:"Report not found"},404); }
      if (req.method === "POST" && path === "/api/reports") {
        // One diagnosis at a time: a second click answers the running one (409) instead of starting another.
        if (!diagnosis) return json({ok:false,error:"Diagnosis is unavailable"},503);
        const b=await body(), {report,started}=diagnosis.start(b.lang==="zh"?"zh":"en",(req.headers.get("cf-access-authenticated-user-email")??"").slice(0,200)||undefined,typeof b.machine==="string"?b.machine:undefined);
        return json({ok:started,report,...(started?{}:{error:"A diagnosis is already running"})},started?202:409);
      }
      if (req.method === "POST" && path === "/api/scan") { void engine.scan().catch(()=>{}); return json({ok:true},202); }
      if (req.method === "POST" && path === "/api/rules") { const rule=validateRule(await body()); if(store.rules().length>=100) throw new Error("At most 100 custom rules");store.put("rule",rule.id,rule);void engine.scan().catch(()=>{});return json({ok:true,rule},201); }
      if (path.startsWith("/api/rules/") && req.method === "PUT") { const id=decodeURIComponent(path.slice(11));if(!store.get("rule",id))return json({ok:false,error:"Rule not found"},404);const rule=validateRule(await body(),id);store.put("rule",id,rule);store.db.query("DELETE FROM documents WHERE kind='check' AND id=?").run(id);void engine.scan().catch(()=>{});return json({ok:true,rule}); }
      if (path.startsWith("/api/checks/") && req.method === "PATCH") {
        const id=decodeURIComponent(path.slice(12)), b=await body(), patch:{enabled?:boolean;mutedUntil?:string|null}={};
        if (typeof b.enabled === "boolean") patch.enabled=b.enabled;
        if (b.muteMinutes !== undefined) { if(!Number.isInteger(b.muteMinutes)||b.muteMinutes<0||b.muteMinutes>10080)throw new Error("Invalid mute duration");patch.mutedUntil=b.muteMinutes?new Date(Date.now()+b.muteMinutes*60_000).toISOString():null; }
        store.control(id,patch);return json({ok:true});
      }
      if (path.startsWith("/api/task-policies/") && req.method === "PUT") {
        // Keyed by the local Space task id; empty fields fall back to the global policy.
        const id=decodeURIComponent(path.slice(19)), b=await body(), policy:TaskPolicy={};
        if(!/^[a-zA-Z0-9-]{1,100}$/.test(id))throw new Error("Invalid task id");
        if(b.deadlineMinutes!==undefined&&b.deadlineMinutes!==null){if(!Number.isInteger(b.deadlineMinutes)||b.deadlineMinutes<1||b.deadlineMinutes>1440)throw new Error("Invalid deadlineMinutes");policy.deadlineMinutes=b.deadlineMinutes;}
        if(b.errorThreshold!==undefined&&b.errorThreshold!==null){if(!Number.isInteger(b.errorThreshold)||b.errorThreshold<1||b.errorThreshold>20)throw new Error("Invalid errorThreshold");policy.errorThreshold=b.errorThreshold;}
        if(Object.keys(policy).length)store.put("taskPolicy",id,policy);else store.db.query("DELETE FROM documents WHERE kind='taskPolicy' AND id=?").run(id);
        void engine.scan().catch(()=>{});return json({ok:true,policy});
      }
      if (req.method === "GET" && path.startsWith("/api/scans/")) { const at=Date.parse(decodeURIComponent(path.slice(11))), record=Number.isFinite(at)?store.scanRecord(at):null; return record?json({ok:true,record}):json({ok:false,error:"Scan not found"},404); }
      const incidentPath=req.method === "POST" ? path.match(/^\/api\/incidents(?:\/([^/]+)(?:\/(ack|notes|resolve))?)?$/) : null;
      if (incidentPath) {
        // The Space ingress (Cloudflare Access) names the operator; without it the record is anonymous.
        const by=(req.headers.get("cf-access-authenticated-user-email")??"").slice(0,200)||undefined, b=await body(), id=incidentPath[1]?decodeURIComponent(incidentPath[1]):null, action=incidentPath[2]??(id?"ack":"create");
        const text=(key:string,max:number,required=false)=>{const v=b[key]===undefined||b[key]===null?"":b[key];if(typeof v!=="string"||v.trim().length>max||(required&&!v.trim()))throw new Error(`Invalid ${key}`);return v.trim();};
        if (action==="create") { if(b.severity!==undefined&&!["warning","critical"].includes(b.severity))throw new Error("Invalid severity");return json({ok:true,incident:store.createIncident({checkId:text("checkId",300)||undefined,name:text("name",120,!b.checkId),app:text("app",80)||undefined,detail:text("detail",2000),severity:b.severity,by})},201); }
        if (action==="notes") return json({ok:true,incident:store.note(id!,text("text",2000,true),by)});
        if (action==="resolve") return json({ok:true,incident:store.resolve(id!,text("text",2000),by)});
        return json({ok:true,incident:store.acknowledge(id!,Date.now(),by)});
      }
      if (path === "/api/settings" && req.method === "PUT") {
        const b=await body(), s=store.settings();
        for (const [key,min,max] of [["scanMinutes",1,60],["failAfter",1,20],["recoverAfter",1,20],["taskErrorThreshold",1,20],["diskPercent",50,99],["memoryPercent",50,99]] as const) { if(b[key]!==undefined){if(!Number.isInteger(b[key])||b[key]<min||b[key]>max)throw new Error(`Invalid ${key}`);s[key]=b[key];} }
        if(b.notifications!==undefined){if(typeof b.notifications!=="boolean")throw new Error("Invalid notifications");if(b.notifications&&!engine.config.appToken)throw new Error("Space notification credentials are unavailable");s.notifications=b.notifications;}
        store.put("settings","main",s satisfies Settings); if(!s.notifications)store.db.exec("DELETE FROM outbox"); engine.reschedule(); return json({ok:true,settings:s});
      }
      return json({ok:false,error:"Not found"},404);
    } catch(e) {return json({ok:false,error:e instanceof Error?e.message:"Request failed"},400);}
  };
}

/** The panel card (ai-space docs/app-spec.md): the list for older panels, state blocks for current ones. */
export function widget(s: Snapshot) {
  const by=(st:string)=>s.checks.filter(c=>c.status===st).length, healthy=by("healthy"), failing=by("failing"), transient=by("transient"), unknown=by("unknown");
  const open=s.incidents.filter(i=>i.status!=="resolved"), critical=open.some(i=>i.severity==="critical");
  const items=[{text:`${s.machine}: ${healthy}/${s.checks.length} checks healthy${transient?` · ${transient} one-off`:""}`,url:"/",time:s.generatedAt},...open.slice(0,4).map(i=>({text:i.name,url:"/#incidents",time:i.openedAt}))];
  const blocks=[
    {type:"progress",label:{en:`Healthy checks · ${s.machine}`,zh:`健康检查 · ${s.machine}`},value:healthy,max:Math.max(s.checks.length,1),display:`${healthy}/${s.checks.length}`,tone:healthy===s.checks.length?"positive":failing?"negative":"warning",url:"/"},
    {type:"metric",label:{en:"Open incidents",zh:"未结事件"},value:open.length,tone:open.length?(critical?"negative":"warning"):"positive",url:"/#incidents"},
    {type:"trend",label:{en:"Failing per scan",zh:"每轮失败数"},caption:{en:`last ${s.history.length} scans`,zh:`最近 ${s.history.length} 轮巡检`},style:"bar",points:s.history.map(h=>({t:h.at,v:h.failing+(h.transient??0)}))},
    {type:"metric",label:{en:"Failing",zh:"失败"},value:failing,tone:failing?"negative":"neutral"},
    {type:"metric",label:{en:"One-off",zh:"偶发"},value:transient,caption:{en:"failed once, not yet confirmed",zh:"单次失败，尚未确认"},tone:transient?"warning":"neutral"},
    {type:"metric",label:{en:"Unknown",zh:"未知"},value:unknown},
    ...open.slice(0,6).map(i=>({type:"status",label:i.app,value:i.name,time:i.openedAt,tone:i.severity==="critical"?"negative":"warning",url:"/#incidents"})),
  ];
  return {ok:true,items,asOf:s.lastScanAt??s.generatedAt,staleAfter:Math.round(s.staleAfterMs/1000),blocks};
}
