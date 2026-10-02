import { validateRule } from "./rules.ts";
import type { Engine } from "./engine.ts";
import type { Check, Settings, TaskPolicy } from "./types.ts";

export function api(engine: Engine) {
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
      if (req.method === "GET" && path === "/api/dashboard") return json({ok:true,local:engine.snapshot(),peers:engine.peers(),rules:store.rules(),settings:store.settings(),taskPolicies:Object.fromEntries((store.db.query("SELECT id,body FROM documents WHERE kind='taskPolicy'").all() as {id:string;body:string}[]).map(r=>[r.id,JSON.parse(r.body)])),busy:engine.busy(),scan:{intervalMs:engine.intervalMs(),nextAt:engine.nextScanAt()},notificationQueue:store.db.query("SELECT COUNT(*) AS pending,SUM(CASE WHEN attempts>=10 THEN 1 ELSE 0 END) AS failed FROM outbox").get(),notificationReady:!!engine.config.appToken});
      if (req.method === "GET" && path === "/api/widget") { const s=engine.snapshot(); return json({ok:true,items:[{text:`${s.machine}: ${s.checks.filter(c=>c.status==="healthy").length}/${s.checks.length} checks healthy${s.checks.some(c=>c.status==="transient")?` · ${s.checks.filter(c=>c.status==="transient").length} one-off`:""}`,url:"/",time:s.generatedAt},...s.incidents.filter(i=>i.status!=="resolved").slice(0,4).map(i=>({text:i.name,url:"/#incidents",time:i.openedAt}))]}); }
      if (req.method === "GET" && path.startsWith("/api/checks/")) { const id=decodeURIComponent(path.slice(12)); return json({ok:true,check:store.get<Check>("check",id),history:store.history(id)}); }
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
