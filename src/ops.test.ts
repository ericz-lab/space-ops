import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { assertionsResult, field, validateRule } from "./rules.ts";
import { backupConfigured, backupSample, declaredNoop, httpProbe, readJson, repeatedSkip, taskSample, withRecoveryEvidence, type Task } from "./probes.ts";
import { Engine, peerDown, renames, tunnelClosed } from "./engine.ts";
import { api, widget } from "./api.ts";
import { BACKUP_UNCONFIGURED, DEFAULT_SETTINGS, type DeclaredCheck, type PeerView, type Sample, type Snapshot } from "./types.ts";
import { snapshotEvidence } from "./diagnose.ts";
import { declared, evaluate, inspect } from "./inspections.ts";

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();});
function store(){const s=new Store(":memory:");stores.push(s);return s;}
const sample:Sample={id:"one",name:"API",app:"example",kind:"http",coverage:"assertion",verdict:"fail",code:"failed",detail:"Wrong output"};
const at=Date.parse("2026-10-01T10:00:00Z");
const mockFetch=(fn:(url:string)=>unknown):typeof fetch=>((async(input:RequestInfo|URL)=>Response.json(fn(String(input)))) as typeof fetch);
const outbox=(s:Store)=>(s.db.query("SELECT id,body FROM outbox ORDER BY rowid").all() as {id:string;body:string}[]).map(r=>({id:r.id,...JSON.parse(r.body) as {level:string;title:string}}));

describe("Incident lifecycle",()=>{
  test("incident thresholds and history survive a collector restart",()=>{
    const dir=mkdtempSync(join(tmpdir(),"space-ops-test-"));
    try {
      const first=new Store(join(dir,"ops.db"));first.observe(sample,at);first.observe(sample,at+1);first.db.close();
      const second=new Store(join(dir,"ops.db"));expect(second.observe(sample,at+2).status).toBe("failing");const id=second.activeIncident("one")!.id;second.acknowledge(id,at+3);second.db.close();
      const third=new Store(join(dir,"ops.db"));expect(third.activeIncident("one")?.status).toBe("acknowledged");expect(third.history("one")).toHaveLength(3);third.db.close();
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  test("debounces failures, deduplicates incidents, requires consecutive recovery",()=>{
    const s=store();expect(s.observe(sample,at).status).toBe("transient");
    s.observe(sample,at+1000);expect(s.observe(sample,at+2000).status).toBe("failing");
    s.observe(sample,at+3000);expect(s.list("incident")).toHaveLength(1);
    const incident=s.activeIncident("one")!;s.acknowledge(incident.id,at+4000);
    expect(s.observe({...sample,verdict:"pass",code:"ok",detail:"Verified"},at+5000).status).toBe("recovering");
    s.observe({...sample,verdict:"unknown"},at+6000);
    expect(s.activeIncident("one")?.status).toBe("acknowledged");
    expect(s.observe({...sample,verdict:"pass"},at+7000).status).toBe("recovering");
    expect(s.observe({...sample,verdict:"pass"},at+8000).status).toBe("healthy");
    expect(s.activeIncident("one")).toBeUndefined();
    expect(s.get<{resolvedAt:string}>("incident",incident.id)?.resolvedAt).toBe(new Date(at+8000).toISOString());
  });
  test("a stale observation becomes unknown without erasing incident evidence",()=>{
    const s=store();s.observe({...sample,verdict:"pass"},at);
    expect(s.snapshot("local",at+181000).checks[0]?.status).toBe("unknown");
    expect(s.get<{status:string}>("check","one")?.status).toBe("healthy");
  });
  test("snapshot advertises collector expiry independently of probe intervals",()=>{
    const s=store();s.finishScan(at);
    expect(s.snapshot("local",at,600000).staleAfterMs).toBe(600000);
    expect(s.snapshot("local",at).lastScanAt).toBe(new Date(at).toISOString());
  });
  test("pausing never resolves an open incident",()=>{
    const s=store();s.observe({...sample,failAfter:1},at);s.control("one",{enabled:false},at+1);
    expect(s.observe({...sample,verdict:"pass"},at+2000).status).toBe("paused");
    expect(s.activeIncident("one")).toBeDefined();
    s.control("one",{enabled:true},at+3000);
    expect(s.observe({...sample,verdict:"pass"},at+4000).status).toBe("recovering");
  });
  test("notifications are opt-in, mute suppresses delivery, transitions enqueue once",()=>{
    const s=store();s.observe({...sample,failAfter:1},at);
    expect(s.db.query("SELECT * FROM outbox").all()).toHaveLength(0);
    s.put("settings","main",{...DEFAULT_SETTINGS,notifications:true});
    s.observe({...sample,id:"two",failAfter:1},at);
    s.observe({...sample,id:"two",failAfter:1},at+1);
    expect(s.db.query("SELECT * FROM outbox").all()).toHaveLength(1);
    s.observe({...sample,id:"three"},at);s.control("three",{mutedUntil:new Date(at+60000).toISOString()});
    s.observe({...sample,id:"three",failAfter:1},at+1);
    expect(s.db.query("SELECT * FROM outbox").all()).toHaveLength(1);
  });
  test("notifications carry a Space notify level: alert when critical, warn otherwise, success on recovery",()=>{
    const s=store();s.put("settings","main",{...DEFAULT_SETTINGS,notifications:true});
    s.observe({...sample,failAfter:1},at);s.observe({...sample,id:"two",failAfter:1,severity:"critical"},at);
    for(const t of [1,2])s.observe({...sample,verdict:"pass",code:"ok"},at+t);
    expect(outbox(s).map(o=>o.level)).toEqual(["warn","alert","success"]);
  });
  test("an info incident is recorded but never notified; rising to warning announces it once, and it never falls back",()=>{
    const s=store();s.put("settings","main",{...DEFAULT_SETTINGS,notifications:true});
    const asleep:Sample={...sample,id:"peer:laptop",name:"laptop",kind:"peer",failAfter:1,severity:"info",detail:"asleep"};
    s.observe(asleep,at);s.observe(asleep,at+1);
    const id=s.activeIncident("peer:laptop")!.id;expect(s.incident(id).severity).toBe("info");expect(outbox(s)).toHaveLength(0);
    s.observe({...asleep,severity:"warning",detail:"asleep too long"},at+2);s.observe({...asleep,severity:"warning",detail:"asleep too long"},at+3);
    const up=s.incident(id);expect(up.severity).toBe("warning");expect(up.events.map(e=>e.type)).toEqual(["opened","escalated"]);
    expect(outbox(s)).toMatchObject([{id:`${id}:opened`,level:"warn",title:"Incident: laptop"}]);
    s.observe(asleep,at+4);expect(s.incident(id).severity).toBe("warning");
    for(const t of [5,6])s.observe({...asleep,severity:undefined,verdict:"pass",code:"ok",detail:"back"},at+t);
    expect(s.incident(id).status).toBe("resolved");expect(outbox(s).map(o=>o.level)).toEqual(["warn","success"]);
    // An info incident that recovers by itself sends nothing at all.
    s.observe({...asleep,id:"peer:other"},at+7);for(const t of [8,9])s.observe({...asleep,id:"peer:other",verdict:"pass",code:"ok"},at+t);
    expect(s.list<{checkId:string;status:string}>("incident").find(i=>i.checkId==="peer:other")?.status).toBe("resolved");expect(outbox(s)).toHaveLength(2);
  });
  test("an operator's incident keeps the severity the operator gave it",()=>{
    const s=store();s.observe({...sample,severity:"info"},at);
    const i=s.createIncident({checkId:"one",detail:"look",severity:"warning"},at+1);
    s.observe({...sample,severity:"critical"},at+2);expect(s.incident(i.id).severity).toBe("warning");
  });
});
describe("Rules and assertions",()=>{
  test("bounded configuration and safe field traversal",()=>{
    expect(()=>validateRule({name:"test",url:"file:///tmp/file"})).toThrow();
    expect(()=>validateRule({name:"test",url:"https://user:pass@example.com"})).toThrow();
    expect(()=>validateRule({name:"test",url:"http://localhost",intervalMs:0})).toThrow();
    expect(()=>validateRule({name:"test",url:"http://localhost",assertions:[{path:"$.value",operator:"evaluate"}]})).toThrow();
    expect(field({items:[{count:3}]},"$.items[0].count")).toBe(3);
    expect(field({},"$.constructor")).toBeUndefined();
  });
  test("missing fields are unknown; exists explicitly fails",()=>{
    expect(assertionsResult({},[{path:"$.ok",operator:"eq",value:true}],at).verdict).toBe("unknown");
    expect(assertionsResult({},[{path:"$.ok",operator:"exists"}],at).verdict).toBe("fail");
    expect(assertionsResult({ok:false},[{path:"$.ok",operator:"eq",value:true}],at).verdict).toBe("fail");
    expect(assertionsResult({ok:true},[{path:"$.ok",operator:"eq",value:true}],at).verdict).toBe("pass");
  });
  test("freshness requires a timezone and rejects future timestamps",()=>{
    const a=[{path:"$.at",operator:"ageLessThan" as const,value:60000}];
    expect(assertionsResult({at:"2026-10-01T09:59:30Z"},a,at).verdict).toBe("pass");
    expect(assertionsResult({at:"2026-10-01T09:00:00Z"},a,at).verdict).toBe("fail");
    expect(assertionsResult({at:"2026-10-01T10:00:00"},a,at).verdict).toBe("unknown");
    expect(assertionsResult({at:"2026-10-02T10:00:00Z"},a,at).code).toBe("clock_skew");
    expect(assertionsResult({at:"2026-02-30T10:00:00Z"},a,at).code).toBe("invalid_timestamp");
  });
  test("HTTP 200 still fails when output assertion fails",async()=>{
    const rule=validateRule({name:"API",url:"http://example.test",assertions:[{path:"$.verified",operator:"eq",value:true}]});
    const result=await httpProbe(rule,mockFetch(()=>({verified:false})),at);
    expect(result.verdict).toBe("fail");expect(result.coverage).toBe("assertion");
    const bad=await httpProbe(rule,(async()=>new Response("not json")) as unknown as typeof fetch,at);
    expect(bad.verdict).toBe("unknown");
  });
});
describe("Task semantics",()=>{
  const task:Task={id:"1",app:"app",name:"job",enabled:true,orphaned:false,timeoutMs:60000,state:{lastStatus:"ok",lastRunAt:"2026-10-01T09:00:00Z"}};
  test("disabled and never-run tasks are not green",()=>{
    expect(taskSample({...task,enabled:false},DEFAULT_SETTINGS,at).verdict).toBe("unknown");
    expect(taskSample({...task,state:{}},DEFAULT_SETTINGS,at).verdict).toBe("unknown");
  });
  test("running tasks respect timeout; overdue schedules and events fail",()=>{
    expect(taskSample({...task,state:{runningAt:"2026-10-01T09:50:00Z"}},DEFAULT_SETTINGS,at).code).toBe("task_stalled");
    expect(taskSample({...task,state:{nextRunAt:"2026-10-01T09:50:00Z"}},DEFAULT_SETTINGS,at).code).toBe("task_overdue");
    expect(taskSample({...task,state:{pending:{dueAt:"2026-10-01T09:50:00Z"}}},DEFAULT_SETTINGS,at).code).toBe("event_overdue");
    expect(taskSample({...task,state:{runningAt:"2026-10-01T09:59:30Z"}},DEFAULT_SETTINGS,at).code).toBe("task_running");
  });
  test("historical failures retain their source time and do not imply business verification",()=>{
    const result=taskSample({...task,state:{...task.state,lastStatus:"error",consecutiveErrors:17}},DEFAULT_SETTINGS,at);
    expect(result.verdict).toBe("fail");expect(result.evidenceAt).toBe(task.state.lastRunAt);expect(result.coverage).toBe("execution");
  });
});
describe("Collector and API",()=>{
  function engine(s:Store,f=mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:{peers:[]})){return new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},f);}
  test("source loss changes discovered checks to unknown",async()=>{
    const s=store();let online=true;
    const e=engine(s,mockFetch(url=>{if(!online)throw new Error("offline");return url.endsWith("services")?{services:[{app:"app",title:"App",status:"active",health:"ok"}]}:url.endsWith("tasks")?{tasks:[]}:{peers:[]};}));
    await e.scan();expect(s.get<CheckLike>("check","service:app")?.status).toBe("healthy");
    online=false;await e.scan();expect(s.get<CheckLike>("check","service:app")?.status).toBe("unknown");
  });
  test("a task that is no longer declared retires its check instead of staying unknown",async()=>{
    const s=store();let tasks:unknown[]=[{id:"t1",app:"app",name:"job",enabled:true,orphaned:false,timeoutMs:60000,state:{lastStatus:"error",lastRunAt:new Date().toISOString(),lastDurationMs:10,consecutiveErrors:3}}];let online=true;
    const e=engine(s,mockFetch(url=>{if(url.endsWith("tasks")){if(!online)throw new Error("offline");return{tasks};}return url.endsWith("services")?{services:[]}:{peers:[]};}));
    for(let i=0;i<3;i++)await e.scan();expect(s.get<CheckLike>("check","task:t1")?.status).toBe("failing");expect(s.activeIncident("task:t1")).toBeDefined();
    online=false;await e.scan();expect(s.get<CheckLike>("check","task:t1")?.status).toBe("unknown");
    online=true;tasks=[{...(tasks[0] as object),orphaned:true}];await e.scan();
    expect(s.get<CheckLike>("check","task:t1")).toBeNull();expect(s.activeIncident("task:t1")).toBeUndefined();
  });
  test("peer failure preserves the last snapshot but marks it unknown",async()=>{
    const s=store();let online=true;
    const e=engine(s,mockFetch(url=>{if(url.includes("/proxy/")){if(!online)throw new Error("offline");return{version:1,machine:"remote",generatedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),checks:[],incidents:[],history:[]};}return url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:{peers:[{name:"remote"}]};}));
    await e.scan();expect(e.peers()[0]?.status).toBe("healthy");online=false;await e.scan();expect(e.peers()[0]?.status).toBe("unknown");expect(e.peers()[0]?.snapshot?.machine).toBe("remote");
  });
  test("a failed peer says why, Space's reason first, and when its last snapshot arrived",async()=>{
    const s=store();let state:{proxy:"ok"|"down"|"stale";space?:string}={proxy:"ok"};
    const f=(async(input:RequestInfo|URL)=>{const url=String(input);
      if(url.includes("/proxy/")){if(state.proxy==="down"||url.includes("/peers/new/"))return new Response("peer remote unreachable",{status:502});return Response.json({version:1,machine:"remote",generatedAt:new Date().toISOString(),lastScanAt:new Date(Date.now()-(state.proxy==="stale"?3600_000:0)).toISOString(),checks:[],incidents:[],history:[]});}
      if(url.endsWith("/api/peers"))return Response.json({peers:[{name:"remote",...(state.space?{error:state.space}:{})},{name:"new",error:"token rejected"}]});
      return Response.json(url.endsWith("services")?{services:[]}:{tasks:[]});}) as typeof fetch;
    const e=engine(s,f),detail=()=>s.get<{detail:string}>("check","peer:remote")?.detail;
    await e.scan();const last=`last snapshot ${s.get<{receivedAt:string}>("peer","remote")!.receivedAt.slice(0,16)}Z`;
    state={proxy:"down",space:"tunnel not connected (Cloudflare 1033)"};await e.scan();
    expect(detail()).toBe(`Peer collector is unavailable: tunnel not connected (Cloudflare 1033); ${last}`);
    expect(e.peers().find(p=>p.name==="remote")?.error).toBe(detail()!);
    expect(s.get<{detail:string}>("check","peer:new")?.detail).toBe("Peer collector is unavailable: token rejected; no snapshot received yet");
    // The same reason reads the same scan after scan: the open incident carries it and gains no event per scan.
    for(let i=0;i<3;i++)await e.scan();
    const open=s.activeIncident("peer:remote")!;expect(open.detail).toBe(detail()!);const events=open.events.length;
    await e.scan();expect(s.activeIncident("peer:remote")!.events.length).toBe(events);
    state={proxy:"down"};await e.scan();expect(detail()).toBe(`Peer collector is unavailable: snapshot read failed (HTTP 502); ${last}`);
    state={proxy:"stale"};await e.scan();expect(detail()).toBe(`Peer collector is unavailable: its last scan expired or its clock differs; ${last}`);
  });
  test("a closed tunnel reads as Space words it, through Space or through the proxy",async()=>{
    const cf=(async()=>new Response("error code: 1033",{status:530})) as unknown as typeof fetch;
    expect(readJson("http://x.test",1000,cf)).rejects.toThrow("HTTP 530 (Cloudflare 1033)");
    expect(tunnelClosed("tunnel not connected (Cloudflare 1033)")).toBe(true);
    for(const other of [undefined,"HTTP 530","HTTP 530 (Cloudflare 1016)","snapshot read failed (HTTP 502)","token rejected","no answer within 10 s"])expect(tunnelClosed(other)).toBe(false);
  });
  test("a peer that may sleep is info while it looks asleep, a warning after its sleep hours or for any other reason",()=>{
    const now=at,last="2026-10-01T09:00:00.000Z",day=new Date(now-25*3600_000).toISOString(),policy={maySleep:true} as const;
    const closed="tunnel not connected (Cloudflare 1033)",expired="its last scan expired or its clock differs";
    // Without the policy nothing changes.
    expect(peerDown(closed,last,null,null,now)).toEqual({code:"peer_unavailable",detail:`Peer collector is unavailable: ${closed}; last snapshot 2026-10-01T09:00Z`});
    expect(peerDown(closed,last,policy,null,now)).toEqual({code:"peer_asleep",severity:"info",detail:`Peer collector is unavailable: ${closed}; last snapshot 2026-10-01T09:00Z; this peer may sleep, so it is info for up to 24 h`});
    // Just woken, before its collector's first scan: still asleep; the same reading on its own is a fault.
    expect(peerDown(expired,last,policy,{code:"peer_asleep",failedAt:last},now).severity).toBe("info");
    expect(peerDown(expired,last,policy,{code:"peer_ok",failedAt:null},now)).toMatchObject({code:"peer_unavailable"});
    // An open tunnel whose space does not answer, a rejected token, no answer: never asleep.
    for(const reason of ["snapshot read failed (HTTP 502)","HTTP 502","token rejected","no answer within 10 s",undefined])expect(peerDown(reason,last,policy,{code:"peer_asleep",failedAt:last},now).severity).toBeUndefined();
    // Asleep longer than its hours: a warning, and the text says why.
    expect(peerDown(closed,day,policy,null,now)).toEqual({code:"peer_unavailable",severity:"warning",detail:`Peer collector is unavailable: ${closed}; last snapshot ${day.slice(0,16)}Z; down longer than the 24 h this peer may sleep`});
    expect(peerDown(closed,day,{maySleep:true,sleepHours:48},null,now).severity).toBe("info");
    // Never read: counted from when this failure began.
    expect(peerDown(closed,null,policy,null,now).severity).toBe("info");
    expect(peerDown(closed,null,policy,{code:"peer_asleep",failedAt:day},now).severity).toBe("warning");
  });
  test("a sleeping peer opens an info incident without a notification, and a warning once asleep too long",async()=>{
    const s=store();let state:{proxy:"ok"|"cf"|"stale"|"down";space?:string}={proxy:"ok"};
    const f=(async(input:RequestInfo|URL)=>{const url=String(input);
      if(url.includes("/proxy/")){if(state.proxy==="cf")return new Response("error code: 1033",{status:530});if(state.proxy==="down")return new Response("bad gateway",{status:502});return Response.json({version:1,machine:"laptop",generatedAt:new Date().toISOString(),lastScanAt:new Date(Date.now()-(state.proxy==="stale"?3600_000:0)).toISOString(),checks:[],incidents:[],history:[]});}
      if(url.endsWith("/api/peers"))return Response.json({peers:[{name:"laptop",...(state.space?{error:state.space}:{})}]});
      return Response.json(url.endsWith("services")?{services:[]}:url.endsWith("checks")?{checks:[]}:{tasks:[]});}) as typeof fetch;
    const e=engine(s,f),handler=api(e),check=()=>s.get<{status:string;code:string;severity?:string;detail:string}>("check","peer:laptop")!;
    const put=(path:string,body:unknown)=>handler(new Request(`http://ops.test${path}`,{method:"PUT",headers:{origin:"http://ops.test","content-type":"application/json"},body:JSON.stringify(body)}));
    await e.scan();
    expect((await put("/api/peer-policies/nobody",{maySleep:true})).status).toBe(404);
    expect((await put("/api/peer-policies/laptop",{maySleep:true,sleepHours:0})).status).toBe(400);
    expect((await put("/api/peer-policies/laptop",{maySleep:"yes"})).status).toBe(400);
    expect(await (await put("/api/peer-policies/laptop",{maySleep:true})).json()).toEqual({ok:true,policy:{maySleep:true}});
    await e.scan();s.put("settings","main",{...DEFAULT_SETTINGS,notifications:true});
    state={proxy:"cf",space:"tunnel not connected (Cloudflare 1033)"};for(let i=0;i<3;i++)await e.scan();
    expect(check()).toMatchObject({status:"failing",code:"peer_asleep",severity:"info"});
    const id=s.activeIncident("peer:laptop")!.id;expect(s.incident(id).severity).toBe("info");expect(outbox(s)).toHaveLength(0);
    // A short wake, its collector not scanned yet; then asleep again, before Space has noticed: Cloudflare's answer through the proxy.
    state={proxy:"stale"};await e.scan();expect(check().code).toBe("peer_asleep");
    state={proxy:"cf"};await e.scan();expect(check()).toMatchObject({code:"peer_asleep",severity:"info"});expect(check().detail).toContain("tunnel not connected (Cloudflare 1033)");
    expect(s.incident(id).severity).toBe("info");expect(outbox(s)).toHaveLength(0);
    // Asleep longer than a day: the last good snapshot is older than the policy's hours.
    s.put("peer","laptop",{...s.get<PeerView>("peer","laptop")!,receivedAt:new Date(Date.now()-25*3600_000).toISOString()});
    state={proxy:"cf",space:"tunnel not connected (Cloudflare 1033)"};await e.scan();
    expect(check()).toMatchObject({code:"peer_unavailable",severity:"warning"});
    expect(s.incident(id).severity).toBe("warning");expect(s.incident(id).events.at(-1)?.type).toBe("escalated");expect(outbox(s).map(o=>o.level)).toEqual(["warn"]);
    state={proxy:"ok"};await e.scan();await e.scan();expect(s.incident(id).status).toBe("resolved");expect(outbox(s).map(o=>o.level)).toEqual(["warn","success"]);
    // The tunnel is up but the machine's space does not answer: a warning from the start.
    state={proxy:"down",space:"HTTP 502"};for(let i=0;i<3;i++)await e.scan();
    expect(s.activeIncident("peer:laptop")?.severity).toBe("warning");expect(outbox(s).map(o=>o.level)).toEqual(["warn","success","warn"]);
    // Cleared, the peer is as before.
    expect(await (await put("/api/peer-policies/laptop",{maySleep:false})).json()).toEqual({ok:true,policy:null});expect(s.get<object>("peerPolicy","laptop")).toBeNull();
  });
  // A fake Space: `list` names the configured peers; `machines` maps a peer name to the collector answering for it (undefined = unreachable).
  function peerSpace(){
    const state={list:[] as string[],listOk:true,machines:{} as Record<string,{machine:string;collector?:string}|undefined>};
    const f=mockFetch(url=>{
      const m=url.match(/\/api\/peers\/([^/]+)\/apps\/space-ops\/proxy\//);
      if(m){const c=state.machines[decodeURIComponent(m[1]!)];if(!c)throw new Error("offline");return{version:1,...c,generatedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),staleAfterMs:240_000,checks:[],incidents:[],history:[]};}
      if(url.endsWith("/api/peers")){if(!state.listOk)throw new Error("offline");return{peers:state.list.map(name=>({name}))};}
      return url.endsWith("services")?{services:[]}:{tasks:[]};
    });
    return {state,f};
  }
  test("a renamed peer keeps its check, history, controls, incidents and reports under the new name",async()=>{
    const s=store(),{state,f}=peerSpace(),e=engine(s,f);
    state.list=["old-name"];state.machines={"old-name":{machine:"box",collector:"c-1"}};
    await e.scan();await e.scan();
    // The machine went down for a while: an automatic incident opened on its peer check.
    state.machines={};for(let i=0;i<3;i++)await e.scan();
    const incident=s.activeIncident("peer:old-name")!;expect(incident).toBeDefined();
    s.control("peer:old-name",{mutedUntil:"2099-01-01T00:00:00.000Z"});s.put("peerPolicy","old-name",{maySleep:true,sleepHours:12});
    s.putReport({id:"r1",machine:"local",machines:["local","old-name"],status:"done",lang:"en",startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),targets:["local","old-name","old-name/app"],coverage:[{name:"Health checks",status:"done",detail:"",machine:"old-name"}]});
    const before=s.history("peer:old-name").length;
    // An unreadable peer list changes nothing.
    state.listOk=false;state.list=["new-name"];state.machines={"new-name":{machine:"box",collector:"c-1"}};await e.scan();
    expect(e.peers().map(p=>p.name)).toEqual(["old-name"]);
    state.listOk=true;await e.scan();
    expect(e.peers().map(p=>p.name)).toEqual(["new-name"]);
    expect(s.get("peer","old-name")).toBeNull();expect(s.get<CheckLike>("check","peer:old-name")).toBeNull();expect(s.get("control","peer:old-name")).toBeNull();
    expect(s.history("peer:old-name")).toHaveLength(0);// One "not observed" while the list was unreadable, one pass after the rename.
    expect(s.history("peer:new-name").length).toBe(before+2);
    expect(s.get<{mutedUntil:string|null}>("check","peer:new-name")?.mutedUntil).toBe("2099-01-01T00:00:00.000Z");
    expect(s.get("peerPolicy","old-name")).toBeNull();expect(s.get<object>("peerPolicy","new-name")).toEqual({maySleep:true,sleepHours:12});
    // The same incident, not a retired one and a new one: it recovers on the machine's new name.
    const moved=s.incident(incident.id);expect(moved.checkId).toBe("peer:new-name");expect(moved.name).toBe("new-name");expect(moved.events.some(ev=>ev.type==="renamed")).toBe(true);
    expect(s.activeIncident("peer:new-name")?.id).toBe(incident.id);await e.scan();expect(s.incident(incident.id).resolvedBy).toBe("check");
    const r=s.report("r1")!;expect(r.machines).toEqual(["local","new-name"]);expect(r.targets).toEqual(["local","new-name","new-name/app"]);expect(r.coverage[0]?.machine).toBe("new-name");
  });
  test("a removed peer is retired, and a new machine is not taken for it",async()=>{
    const s=store(),{state,f}=peerSpace(),e=engine(s,f);
    state.list=["old-name"];state.machines={"old-name":{machine:"box",collector:"c-1"}};await e.scan();s.put("peerPolicy","old-name",{maySleep:true});
    state.list=["other"];state.machines={other:{machine:"box",collector:"c-2"}};await e.scan();
    expect(e.peers().map(p=>p.name)).toEqual(["other"]);expect(s.get("peerPolicy","old-name")).toBeNull();expect(s.get("peer","old-name")).toBeNull();expect(s.get<CheckLike>("check","peer:old-name")).toBeNull();
    expect(s.history("peer:other")).toHaveLength(1);expect(s.history("peer:old-name")).toHaveLength(1);
  });
  test("a gone peer waits, unlisted, until the newly named peer can say whether it is the same machine",async()=>{
    const s=store(),{state,f}=peerSpace(),e=engine(s,f);
    state.list=["old-name"];state.machines={"old-name":{machine:"box",collector:"c-1"}};await e.scan();
    state.list=["new-name"];state.machines={};await e.scan();
    expect(e.peers().map(p=>p.name)).toEqual(["new-name"]);expect(s.get<{missingSince?:string}>("peer","old-name")?.missingSince).toBeDefined();
    state.machines={"new-name":{machine:"box",collector:"c-1"}};await e.scan();
    expect(s.get("peer","old-name")).toBeNull();expect(s.history("peer:new-name").length).toBe(3);
  });
  test("a collector without an id is matched by the name the machine calls itself, only when that is unambiguous",()=>{
    const snap=(machine:string,collector?:string)=>({version:1 as const,machine,...(collector?{collector}:{}),generatedAt:"",lastScanAt:null,staleAfterMs:240_000,checks:[],incidents:[],history:[]});
    expect(renames([{name:"a",snapshot:snap("box")}],[{name:"b",snapshot:snap("box")}])).toEqual([["a","b"]]);
    expect(renames([{name:"a",snapshot:snap("box")}],[{name:"b",snapshot:snap("box")},{name:"c",snapshot:snap("box")}])).toEqual([]);
    expect(renames([{name:"a",snapshot:snap("box","c-1")}],[{name:"b",snapshot:snap("box","c-2")}])).toEqual([]);
    expect(renames([{name:"a",snapshot:snap("box","c-1")}],[{name:"b",snapshot:snap("other","c-1")}])).toEqual([["a","b"]]);
    expect(renames([{name:"a",snapshot:null}],[{name:"b",snapshot:snap("box")}])).toEqual([]);
  });
  test("an operator moves what an earlier retirement left under the old name",async()=>{
    const s=store(),{state,f}=peerSpace(),e=engine(s,f),handler=api(e);
    state.list=["old-name"];state.machines={"old-name":{machine:"box"}};await e.scan();
    // Renamed while the machine also changed its own name: nothing ties the two, so the old one is retired.
    state.list=["new-name"];state.machines={"new-name":{machine:"box-2"}};await e.scan();
    expect(s.history("peer:old-name")).toHaveLength(1);
    const post=(path:string,data:unknown)=>handler(new Request(`http://ops.test${path}`,{method:"POST",headers:{"content-type":"application/json",origin:"http://ops.test"},body:JSON.stringify(data)}));
    expect((await post("/api/peers/new-name/rename",{to:"new-name"})).status).toBe(400);
    expect((await post("/api/peers/old-name/rename",{to:"nobody"})).status).toBe(404);
    expect((await post("/api/peers/new-name/rename",{to:"new-name-2"})).status).toBe(404);
    const res=await post("/api/peers/old-name/rename",{to:"new-name"});expect(res.status).toBe(200);
    expect(((await res.json()) as {moved:{observations:number}}).moved.observations).toBe(1);
    expect(s.history("peer:old-name")).toHaveLength(0);expect(s.history("peer:new-name")).toHaveLength(2);
    expect((await post("/api/peers/old-name/rename",{to:"new-name"})).status).toBe(404);
  });
  test("the snapshot carries a collector id that survives a restart",()=>{
    const dir=mkdtempSync(join(tmpdir(),"space-ops-test-"));
    try { const a=new Store(join(dir,"ops.db")),id=a.snapshot("m").collector;a.db.close();const b=new Store(join(dir,"ops.db"));expect(id).toBeTruthy();expect(b.snapshot("m").collector).toBe(id!);b.db.close(); }
    finally {rmSync(dir,{recursive:true,force:true});}
  });
  test("same-origin JSON is required for mutations",async()=>{
    const s=store(),handler=api(engine(s));
    const request=(origin?:string)=>new Request("http://ops.test/api/rules",{method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body:JSON.stringify({name:"API",url:"http://example.test"})});
    expect((await handler(request())).status).toBe(403);
    expect((await handler(request("http://evil.test"))).status).toBe(403);
    expect((await handler(request("https://ops.test:444"))).status).toBe(403);
    expect((await handler(request("http://ops.test"))).status).toBe(201);
    expect((await handler(request("https://ops.test"))).status).toBe(201);
    await new Promise(r=>setTimeout(r,20));
    expect(s.rules()).toHaveLength(2);
  });
});
type CheckLike={status:string};


test("recovery requires newer, fresh, enabled and verified evidence and keeps incident history", async () => {
  const s=store();
  const rule=validateRule({name:"Completion",url:"http://example.test/status",intervalMs:60000,recoveryTaskId:"task-1",evidenceTimestampPath:"$.finishedAt",assertions:[{path:"$.ok",operator:"eq",value:true}]});
  const failed:Sample={...sample,id:"task:task-1",kind:"task",code:"task_errors",evidenceAt:new Date(at-60000).toISOString(),failAfter:1};
  s.observe(failed,at);
  const evidence=await httpProbe(rule,mockFetch(()=>({ok:true,finishedAt:new Date(at-1000).toISOString()})),at);
  const check=s.observe(evidence,at);
  const recovered=withRecoveryEvidence(failed,[rule],[check],at);
  expect(recovered.code).toBe("task_recovered_evidence");
  expect(s.observe(recovered,at+1).status).toBe("recovering");
  expect(s.observe(recovered,at+2).status).toBe("healthy");
  expect(s.snapshot("test",at+2).incidents[0]?.events.at(-1)?.type).toBe("resolved");
  for (const bad of [{...check,enabled:false},{...check,status:"unknown" as const},{...check,observedAt:new Date(at-900000).toISOString()},{...check,evidenceAt:failed.evidenceAt}]) expect(withRecoveryEvidence(failed,[rule],[bad],at).verdict).toBe("fail");
  expect(withRecoveryEvidence({...failed,evidenceAt:new Date(at).toISOString()},[rule],[check],at).verdict).toBe("fail");
  expect(withRecoveryEvidence({...failed,code:"task_stalled"},[rule],[check],at).verdict).toBe("fail");
  expect(withRecoveryEvidence(failed,[{...rule,enabled:false}],[check],at).verdict).toBe("fail");
  for (const finishedAt of [null,"2026-02-30T00:00:00Z",new Date(at+120000).toISOString()]) expect((await httpProbe(rule,mockFetch(()=>({ok:true,finishedAt})),at)).verdict).toBe("unknown");
  expect(()=>validateRule({name:"Bad",url:"http://example.test",recoveryTaskId:"task-1"})).toThrow();
});

test("a running task cannot close an existing incident",()=>{
  const s=store();
  const failed:Sample={...sample,id:"task:task-1",failAfter:1};s.observe(failed,at);
  const t:Task={id:"task-1",app:"test",name:"sync",enabled:true,orphaned:false,timeoutMs:60000,state:{runningAt:new Date(at-1000).toISOString()}};
  const observation=taskSample(t,DEFAULT_SETTINGS,at);
  expect(observation.verdict).toBe("unknown");
  s.observe(observation,at+1);s.observe(observation,at+2);
  expect(s.activeIncident(t.id ? `task:${t.id}` : "")?.status).toBe("open");
});


test("successful execution with partial failures still opens a separate quality incident",async()=>{
  const s=store();
  const quality=validateRule({name:"Symbol completeness",url:"http://example.test/status",failAfter:1,recoverAfter:2,assertions:[{path:"$.status",operator:"eq",value:"ok"},{path:"$.failed",operator:"eq",value:0}]});
  const partial=await httpProbe(quality,mockFetch(()=>({status:"ok",failed:34})),at);
  expect(partial.verdict).toBe("fail");expect(partial.detail).toContain("34");
  expect(s.observe(partial,at).status).toBe("failing");
  const complete=await httpProbe(quality,mockFetch(()=>({status:"ok",failed:0})),at+1);
  expect(s.observe(complete,at+1).status).toBe("recovering");
  expect(s.observe(complete,at+2).status).toBe("healthy");
});


test("recovery evidence must postdate the failed attempt end",()=>{
  const result=taskSample({id:"task-1",app:"test",name:"sync",enabled:true,orphaned:false,timeoutMs:60000,state:{lastStatus:"error",lastRunAt:"2026-10-01T09:00:00Z",lastDurationMs:300000,consecutiveErrors:3}},DEFAULT_SETTINGS,at);
  expect(result.evidenceAt).toBe("2026-10-01T09:05:00.000Z");
});

describe("One-off errors",()=>{
  const task:Task={id:"t",app:"app",name:"job",enabled:true,orphaned:false,timeoutMs:60000,state:{lastStatus:"error",lastRunAt:"2026-10-01T09:00:00Z",lastDurationMs:1000,consecutiveErrors:1}};
  test("a failed run below the threshold is a one-off error, never healthy and never an incident",()=>{
    const s=store(),one=taskSample(task,DEFAULT_SETTINGS,at);
    expect(one.transient).toBe(true);
    for(let i=0;i<5;i++)expect(s.observe(one,at+i).status).toBe("transient");
    expect(s.activeIncident("task:t")).toBeUndefined();
    expect(s.get<{failedAt:string}>("check","task:t")?.failedAt).toBe("2026-10-01T09:00:01.000Z");
    const ok=taskSample({...task,state:{lastStatus:"ok",lastRunAt:"2026-10-01T09:30:00Z"}},DEFAULT_SETTINGS,at);
    const cleared=s.observe(ok,at+10);
    expect(cleared.status).toBe("healthy");expect(cleared.failedAt).toBe("2026-10-01T09:00:01.000Z");
    expect(taskSample({...task,state:{...task.state,consecutiveErrors:3}},DEFAULT_SETTINGS,at).verdict).toBe("fail");
    expect(taskSample({...task,state:{lastStatus:"skipped",lastRunAt:"2026-10-01T09:00:00Z"}},DEFAULT_SETTINGS,at).transient).toBe(true);
  });
  test("an open incident keeps a later one-off observation unknown",()=>{
    const s=store();s.observe({...sample,id:"task:t",failAfter:1},at);
    expect(s.observe(taskSample(task,DEFAULT_SETTINGS,at),at+1).status).toBe("unknown");
    expect(s.activeIncident("task:t")).toBeDefined();
  });
  test("absent resources lose their one-off state",async()=>{
    const s=store();s.observe({...taskSample(task,DEFAULT_SETTINGS,at),id:"task:gone"},at);
    await new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:{peers:[]})).scan();
    // The task list answered without it: the check is retired, so no one-off state can linger.
    expect(s.get<CheckLike>("check","task:gone")).toBeNull();
  });
  test("re-reading the same failed result counts once; a new failed result counts again",async()=>{
    const s=store(),rule=validateRule({name:"Sync",url:"http://example.test",failAfter:2,evidenceTimestampPath:"$.latest.finishedAt",assertions:[{path:"$.latest.failed",operator:"eq",value:0}]});
    const read=(finishedAt:string,failed:number)=>httpProbe(rule,mockFetch(()=>({latest:{finishedAt,failed}})),at);
    const first=await read("2026-10-01T09:00:00Z",3);
    for(let i=0;i<10;i++)expect(s.observe(first,at+i).status).toBe("transient");
    expect(s.get<{failures:number}>("check",rule.id)?.failures).toBe(1);
    expect(s.observe(await read("2026-10-01T09:30:00Z",3),at+20).status).toBe("failing");
    expect(s.activeIncident(rule.id)).toBeDefined();
  });
  test("result timestamp may be set without recovery mapping, recovery still needs it",()=>{
    expect(validateRule({name:"Sync",url:"http://example.test",evidenceTimestampPath:"$.latest.finishedAt"}).evidenceTimestampPath).toBe("$.latest.finishedAt");
    expect(()=>validateRule({name:"Sync",url:"http://example.test",evidenceTimestampPath:"latest"})).toThrow();
    expect(()=>validateRule({name:"Sync",url:"http://example.test",recoveryTaskId:"task-1",assertions:[{path:"$.ok",operator:"exists"}]})).toThrow();
    expect(validateRule({name:"Sync",url:"http://example.test"}).intervalMs).toBe(300_000);
  });
  test("scan history counts one-off errors apart from failures",()=>{
    const s=store();s.observe(sample,at);s.finishScan(at);
    expect(s.snapshot("local",at).history[0]).toMatchObject({failing:0,transient:1});
  });
});

describe("Scan cadence",()=>{
  test("defaults to five minutes, is validated and stretches the expiry lease",async()=>{
    const s=store(),e=new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30}),handler=api(e);
    expect(e.intervalMs()).toBe(300_000);expect(e.leaseMs()).toBe(1_200_000);
    const put=(body:unknown)=>handler(new Request("http://ops.test/api/settings",{method:"PUT",headers:{"content-type":"application/json",origin:"http://ops.test"},body:JSON.stringify(body)}));
    expect((await put({scanMinutes:0})).status).toBe(400);
    expect((await put({scanMinutes:61})).status).toBe(400);
    expect((await put({scanMinutes:15})).status).toBe(200);
    expect(e.intervalMs()).toBe(900_000);expect(e.snapshot().staleAfterMs).toBe(3_600_000);
    const dash=await (await handler(new Request("http://ops.test/api/dashboard"))).json() as {scan:{intervalMs:number}};
    expect(dash.scan.intervalMs).toBe(900_000);
  });
  test("a short rule interval expires on the scan cadence",async()=>{
    const s=store();s.put("rule","r",validateRule({name:"API",url:"http://example.test/ok",intervalMs:60_000},"r"));
    await new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:url.endsWith("peers")?{peers:[]}:{ok:true})).scan();
    expect(s.get<{staleAfterMs:number}>("check","r")?.staleAfterMs).toBe(300_000*3+5000);
  });
});

describe("Daily deadlines",()=>{
  const a=[{path:"$.latestPublishedAt",operator:"dailyBy" as const,value:"15:00"}],zone="Asia/Shanghai";
  // 2026-10-02 14:59 and 15:01 in Shanghai.
  const before=Date.parse("2026-10-02T06:59:00Z"),after=Date.parse("2026-10-02T07:01:00Z");
  test("requires today's date at the deadline and waits beforehand",()=>{
    const yesterday={latestPublishedAt:"2026-10-01T05:02:51Z"},today={latestPublishedAt:"2026-10-01T16:30:00Z"};
    expect(assertionsResult(yesterday,a,before,zone).verdict).toBe("unknown");
    expect(assertionsResult(yesterday,a,after,zone)).toMatchObject({verdict:"fail",code:"daily_deadline_missed"});
    expect(assertionsResult(today,a,after,zone).verdict).toBe("pass");
    expect(assertionsResult({latestPublishedAt:"2026-09-30T10:00:00Z"},a,before,zone).verdict).toBe("unknown");
    expect(assertionsResult({latestPublishedAt:null},a,after,zone).verdict).toBe("unknown");
    expect(assertionsResult({latestPublishedAt:"2026-10-02 05:00:00"},a,after,zone).verdict).toBe("unknown");
  });
  test("needs a valid time and an explicit IANA zone",()=>{
    expect(()=>validateRule({name:"Daily",url:"http://example.test",assertions:a})).toThrow();
    expect(()=>validateRule({name:"Daily",url:"http://example.test",timezone:"Mars/Base",assertions:a})).toThrow();
    expect(()=>validateRule({name:"Daily",url:"http://example.test",timezone:zone,assertions:[{...a[0],value:"25:00"}]})).toThrow();
    expect(validateRule({name:"Daily",url:"http://example.test",timezone:zone,assertions:a}).timezone).toBe(zone);
  });
  test("a probe evaluates the deadline in the rule's zone",async()=>{
    const rule=validateRule({name:"Daily",url:"http://example.test",timezone:zone,failAfter:1,assertions:a});
    expect((await httpProbe(rule,mockFetch(()=>({latestPublishedAt:"2026-10-01T05:02:51Z"})),after)).verdict).toBe("fail");
    expect((await httpProbe({...rule,timezone:"America/New_York"},mockFetch(()=>({latestPublishedAt:"2026-10-01T05:02:51Z"})),after)).code).toBe("rule_before_deadline");
  });
});

describe("Task policies",()=>{
  const task:Task={id:"us",app:"picker",name:"daily-sync-us",enabled:true,orphaned:false,timeoutMs:3600000,state:{runningAt:"2026-10-01T08:55:00Z"}};
  test("a run not successful within its deadline fails on the first observation",()=>{
    const s=store(),late=taskSample(task,DEFAULT_SETTINGS,at,{deadlineMinutes:60});
    expect(late).toMatchObject({verdict:"fail",code:"task_deadline",failAfter:1});
    expect(s.observe(late,at).status).toBe("failing");expect(s.activeIncident("task:us")).toBeDefined();
    expect(taskSample({...task,state:{runningAt:"2026-10-01T09:05:00Z"}},DEFAULT_SETTINGS,at,{deadlineMinutes:60}).code).toBe("task_running");
    expect(taskSample({...task,timeoutMs:7200000},DEFAULT_SETTINGS,at).code).toBe("task_running");
  });
  test("an error threshold of one makes a single failed run a failure, not a one-off",()=>{
    const failed={...task,state:{lastStatus:"error",lastRunAt:"2026-10-01T08:00:00Z",consecutiveErrors:1}};
    expect(taskSample(failed,DEFAULT_SETTINGS,at).transient).toBe(true);
    expect(taskSample(failed,DEFAULT_SETTINGS,at,{errorThreshold:1})).toMatchObject({verdict:"fail",failAfter:1});
    expect(taskSample({...task,state:{lastStatus:"skipped",lastRunAt:"2026-10-01T08:00:00Z"}},DEFAULT_SETTINGS,at,{errorThreshold:1}).verdict).toBe("fail");
  });
  test("policies are validated, stored, listed and cleared through the API",async()=>{
    const s=store(),handler=api(new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},mockFetch(()=>({services:[],tasks:[],peers:[]}))));
    const put=(id:string,body:unknown)=>handler(new Request(`http://ops.test/api/task-policies/${id}`,{method:"PUT",headers:{"content-type":"application/json",origin:"http://ops.test"},body:JSON.stringify(body)}));
    expect((await put("us",{deadlineMinutes:0})).status).toBe(400);
    expect((await put("bad id",{deadlineMinutes:60})).status).toBe(400);
    expect((await put("us",{deadlineMinutes:60,errorThreshold:1})).status).toBe(200);
    const dash=await (await handler(new Request("http://ops.test/api/dashboard"))).json() as {taskPolicies:Record<string,unknown>};
    expect(dash.taskPolicies.us).toEqual({deadlineMinutes:60,errorThreshold:1});
    await put("us",{});expect(s.get("taskPolicy","us")).toBeNull();
  });
});

describe("Repeated skips",()=>{
  const now=Date.parse("2026-10-02T03:00:00Z"), at=(h:number)=>now-h*3_600_000, skip=(h:number)=>({status:"skipped",startedAt:at(h),endedAt:at(h)});
  test("skips after a recent success mean up to date",()=>{
    expect(repeatedSkip([skip(0),skip(.5),skip(1),{status:"ok",startedAt:at(1.5),endedAt:at(1.5)}],now)).toBe(false);
  });
  test("skips with no success in a day are a failure",()=>{
    expect(repeatedSkip([skip(0),skip(.5),skip(1),{status:"ok",startedAt:at(30),endedAt:at(30)}],now)).toBe(true);
    expect(repeatedSkip([skip(0),skip(.5),skip(1)],now)).toBe(true);
  });
  const closed=(h:number)=>({...skip(h),output:JSON.stringify({status:"skipped",reason:"market_closed"})});
  test("a skip that declares a reason and no error is a planned no-op",()=>{
    expect(declaredNoop(closed(0))).toBe("market_closed");
    expect(declaredNoop({...closed(0),error:"already running"})).toBeUndefined();
    expect(declaredNoop(skip(0))).toBeUndefined();
    expect(repeatedSkip([closed(0),closed(24),closed(48)],now)).toBe(false);
  });
  test("a holiday skip is healthy even under an error threshold of one",async()=>{
    const s=store(),t:Task={id:"cn",app:"picker",name:"daily-sync",enabled:true,orphaned:false,timeoutMs:60000,state:{lastStatus:"skipped",lastRunAt:new Date().toISOString(),lastDurationMs:5}};
    s.put("taskPolicy","cn",{errorThreshold:1});
    await new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("/api/tasks")?{tasks:[t]}:url.includes("/runs")?{runs:[closed(0)]}:{peers:[]})).scan();
    expect(s.get<CheckLike>("check","task:cn")?.status).toBe("healthy");
    expect(s.activeIncident("task:cn")).toBeUndefined();
  });
  test("fewer than three skips is not repeated",()=>{
    expect(repeatedSkip([skip(0),skip(.5),{status:"error"}],now)).toBe(false);
  });
});

describe("Operator incidents",()=>{
  const fail=(s:Store,n:number,t0=at)=>{for(let i=0;i<n;i++)s.observe(sample,t0+i*1000);};
  const pass={...sample,verdict:"pass" as const,code:"ok",detail:"Verified"};
  test("notes and an operator resolution are kept; a still-failing check needs failAfter new failures to reopen",()=>{
    const s=store();fail(s,3);const id=s.activeIncident("one")!.id;
    s.note(id,"Restarted the supplier job","ops@example.com",at+5000);
    const done=s.resolve(id,"Supplier fixed",undefined,at+6000);
    expect(done).toMatchObject({status:"resolved",resolvedBy:"operator"});
    expect(done.events.map(e=>e.type)).toEqual(["opened","note","resolved"]);
    expect(done.events[1]).toMatchObject({detail:"Restarted the supplier job",by:"ops@example.com"});
    expect(()=>s.resolve(id,"",undefined,at+6500)).toThrow("already resolved");
    expect(s.observe(sample,at+7000).status).toBe("transient");expect(s.activeIncident("one")).toBeUndefined();
    fail(s,2,at+8000);expect(s.activeIncident("one")?.id).not.toBe(id);
  });
  test("an operator incident on a check stays open when the check recovers, and only one is open per check",()=>{
    const s=store();s.observe(sample,at);
    const i=s.createIncident({checkId:"one",detail:"Looks flaky",by:"ops"},at+100);
    expect(i).toMatchObject({source:"manual",name:"API",app:"example",status:"open"});
    expect(()=>s.createIncident({checkId:"one",detail:"again"})).toThrow("already open");
    expect(()=>s.createIncident({checkId:"missing",detail:"x"})).toThrow("Check not found");
    s.observe(pass,at+1000);s.observe(pass,at+2000);s.observe(pass,at+3000);
    const kept=s.incident(i.id);expect(kept.status).toBe("open");expect(kept.events.filter(e=>e.type==="recovered")).toHaveLength(1);
    s.resolve(i.id,"Confirmed fine","ops",at+4000);expect(s.incident(i.id).resolvedBy).toBe("ops");
    const free=s.createIncident({name:"Router certificate expires soon",detail:"Renew before Friday"},at);
    expect(free.checkId.startsWith("manual:")).toBe(true);expect(free.app).toBe("custom");
  });
  test("operator records survive event trimming",()=>{
    const s=store();fail(s,3);const id=s.activeIncident("one")!.id;s.note(id,"first note",undefined,at+3000);
    for(let i=0;i<150;i++)s.observe({...sample,detail:`Wrong output ${i}`},at+4000+i);
    const e=s.incident(id).events;expect(e).toHaveLength(100);expect(e[0]!.type).toBe("opened");expect(e.some(x=>x.detail==="first note")).toBe(true);expect(e.at(-1)!.detail).toBe("Wrong output 149");
  });
  test("a scan record lists what failed in that scan only",()=>{
    const s=store();s.observe(sample,at);s.observe({...sample,id:"two",name:"Other"},at+10);s.finishScan(at+100);
    s.observe(pass,at+200);s.finishScan(at+300);
    expect(s.scanRecord(at+100)!.checks.map(c=>[c.id,c.status])).toEqual([["one","transient"],["two","transient"]]);
    expect(s.scanRecord(at+300)!).toMatchObject({previousAt:new Date(at+100).toISOString(),checks:[]});
    expect(s.scanRecord(at+999)).toBeNull();
  });
  test("API: create, note, resolve, acknowledge; validation and the access identity",async()=>{
    const s=store(),handler=api(new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30}));fail(s,3);
    const post=(path:string,body:unknown,extra:Record<string,string>={})=>handler(new Request(`http://ops.test${path}`,{method:"POST",headers:{"content-type":"application/json",origin:"http://ops.test",...extra},body:JSON.stringify(body)}));
    const auto=s.activeIncident("one")!.id;
    expect((await post(`/api/incidents/${auto}/notes`,{text:" "})).status).toBe(400);
    const noted=await (await post(`/api/incidents/${auto}/notes`,{text:"Checked logs"},{"cf-access-authenticated-user-email":"eric@example.com"})).json();
    expect(noted.incident.events.at(-1)).toMatchObject({type:"note",by:"eric@example.com"});
    expect((await post(`/api/incidents/${auto}`,{})).status).toBe(200);expect(s.incident(auto).status).toBe("acknowledged");
    expect((await post(`/api/incidents/${auto}/resolve`,{text:"Fixed"})).status).toBe(200);
    expect((await post(`/api/incidents/${auto}/resolve`,{})).status).toBe(400);
    expect((await post("/api/incidents",{detail:"no name"})).status).toBe(400);
    expect((await post("/api/incidents",{name:"Disk swap",detail:"Planned",severity:"fatal"})).status).toBe(400);
    const made=await post("/api/incidents",{checkId:"one",detail:"Escalated"});expect(made.status).toBe(201);
    expect((await post("/api/incidents/nope/notes",{text:"x"})).status).toBe(400);
  });
});

describe("Inspections (点检)",()=>{
  // 2026-10-02 10:00 Hong Kong
  const now=Date.parse("2026-10-02T02:00:00Z");
  const hk:DeclaredCheck={id:"picker/hk-today",app:"picker",appTitle:"Picker",name:"hk-today",url:"http://127.0.0.1:8975/api/sync-status?market=hk",when:[{path:"$.today.open",operator:"eq",value:true}],done:[{path:"$.today.done",operator:"eq",value:true}],due:"18:00",timezone:"Asia/Hong_Kong"};
  test("not done before the deadline is pending, after it late; a closed day is off",()=>{
    expect(evaluate(hk,{today:{open:true,done:true}},now).state).toBe("done");
    expect(evaluate(hk,{today:{open:true,done:false}},now).state).toBe("pending");
    expect(evaluate(hk,{today:{open:true,done:false}},now+9*3_600_000).state).toBe("late");
    expect(evaluate(hk,{today:{open:false,done:false}},now).state).toBe("off");
    expect(evaluate(hk,{today:{open:null,done:false}},now).state).toBe("unknown");
    expect(evaluate({...hk,due:undefined},{today:{open:true,done:false}},now).state).toBe("late");
  });
  test("today compares the timestamp's local date in the check's timezone",()=>{
    const c:DeclaredCheck={...hk,when:undefined,due:"15:00",timezone:"Asia/Shanghai",done:[{path:"$.latestPublishedAt",operator:"today"}]};
    expect(evaluate(c,{latestPublishedAt:"2026-10-02T01:00:00Z"},now).state).toBe("done");
    expect(evaluate(c,{latestPublishedAt:"2026-10-01T16:01:00Z"},now).state).toBe("done");
    expect(evaluate(c,{latestPublishedAt:"2026-10-01T15:59:00Z"},now).state).toBe("pending");
    expect(evaluate(c,{latestPublishedAt:"2026-10-01"},now).state).toBe("unknown");
  });
  test("a scan reads declared checks, never opens incidents and forgets undeclared ones",async()=>{
    const s=store();let checks=[hk];
    const fetcher=mockFetch(url=>url.endsWith("/api/checks")?{checks}:url.includes("8975")?{today:{open:true,done:false}}:url.endsWith("services")?{services:[]}:url.endsWith("/api/tasks")?{tasks:[]}:{peers:[]});
    const engine=new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},fetcher);
    await engine.scan();
    const snap=engine.snapshot();
    expect(snap.inspections?.map(i=>[i.id,i.state])).toEqual([["picker/hk-today",expect.stringMatching(/pending|late/)]]);
    expect(snap.incidents).toHaveLength(0);
    expect(snap.checks.some(c=>c.id==="picker/hk-today")).toBe(false);
    expect(snap.checks.find(c=>c.id==="source:checks")?.verdict).toBe("pass");
    checks=[];await engine.scan();
    expect(engine.snapshot().inspections).toEqual([]);
  });
  test("remembers the last done reading and expires old readings",()=>{
    const s=store(),base={id:"a/b",app:"a",appTitle:"A",name:"b",detail:"",observedAt:new Date(now).toISOString()};
    s.putInspection({...base,state:"done"});s.putInspection({...base,state:"pending",observedAt:new Date(now+60_000).toISOString()});
    expect(s.snapshot("m",now+120_000).inspections?.[0]).toMatchObject({state:"pending",doneAt:new Date(now).toISOString()});
    expect(s.snapshot("m",now+3_600_000).inspections?.[0]?.state).toBe("unknown");
  });
  test("only reads this machine's loopback",async()=>{
    expect((await inspect({...hk,url:"http://example.com/x"},mockFetch(()=>({})),now)).state).toBe("unknown");
    expect(declared({checks:[hk,{id:1}]})).toEqual([hk]);
  });
});

describe("Widget",()=>{
  test("blocks: healthy share first, incidents by severity, failing per scan from the recorded scans only",()=>{
    const s=store();
    s.observe({...sample,id:"ok",verdict:"pass",code:"ok"},at);
    s.observe(sample,at);s.observe(sample,at+1);s.observe(sample,at+2);
    const w=widget(s.snapshot("local",at+3,600000));
    expect(w.items[0]?.text).toBe("local: 1/2 checks healthy");
    expect(w.staleAfter).toBe(600);
    expect(w.blocks[0]).toMatchObject({type:"progress",value:1,max:2,display:"1/2",tone:"negative"});
    expect(w.blocks[1]).toMatchObject({type:"metric",value:1,tone:"warning"});
    expect(w.blocks[2]).toMatchObject({type:"trend",style:"bar"});
    expect((w.blocks[2] as {points:unknown[]}).points).toHaveLength(s.snapshot("local",at+3).history.length);
    expect(w.blocks.at(-1)).toMatchObject({type:"status",label:"example",value:"API",tone:"warning"});
  });
  test("an info failure is counted but never turns the card red",()=>{
    const s=store();
    s.observe({...sample,id:"ok",verdict:"pass",code:"ok"},at);
    for(const t of [0,1,2])s.observe({...sample,severity:"info"},at+t);
    const w=widget(s.snapshot("local",at+3,600000));
    expect(w.blocks[0]).toMatchObject({type:"progress",value:1,max:2,tone:"warning"});
    expect(w.blocks[1]).toMatchObject({type:"metric",value:1,tone:"neutral"});
    expect(w.blocks.find(b=>JSON.stringify(b.label).includes('"Failing"'))).toMatchObject({value:1,tone:"warning"});
    expect(w.blocks.at(-1)).toMatchObject({type:"status",value:"API",tone:"neutral"});
  });
});

describe("HTTP rule weekdays",()=>{
  const weekdays=[2,3,4,5,6];
  const raw={name:"Daily",url:"http://example.test",timezone:"Asia/Shanghai",weekdays,failAfter:1,recoverAfter:1,assertions:[{path:"$.finishedAt",operator:"dailyBy",value:"15:00"}]};
  test("validates weekdays and requires their timezone",()=>{
    for(const value of [[],[7],[-1],[1.5],[1,1],["2"],null,"2,3"]) expect(()=>validateRule({...raw,weekdays:value})).toThrow();
    expect(()=>validateRule({...raw,timezone:undefined})).toThrow();
    expect(validateRule(raw).weekdays).toEqual(weekdays);
    expect(validateRule({...raw,weekdays:undefined}).weekdays).toBeUndefined();
  });
  test("skips Sunday and Monday without HTTP requests using Shanghai midnight",async()=>{
    const rule=validateRule(raw);let requests=0;
    const fetcher=mockFetch(()=>{requests++;return {finishedAt:"2026-10-10T06:00:00Z"};});
    for(const instant of ["2026-10-10T16:00:00Z","2026-10-11T07:00:00Z","2026-10-12T15:59:59Z"]){
      expect(await httpProbe(rule,fetcher,Date.parse(instant))).toMatchObject({verdict:"unknown",code:"rule_offday"});
    }
    expect(requests).toBe(0);
    expect((await httpProbe(rule,fetcher,Date.parse("2026-10-10T15:59:59Z"))).verdict).toBe("pass");
    expect((await httpProbe(rule,fetcher,Date.parse("2026-10-12T16:00:00Z"))).code).toBe("rule_before_deadline");
    expect(requests).toBe(1);
  });
  test("Tuesday waits before 15:00 and requires Tuesday at the deadline",async()=>{
    const rule=validateRule(raw),fetcher=mockFetch(()=>({finishedAt:"2026-10-10T06:00:00Z"}));
    expect((await httpProbe(rule,fetcher,Date.parse("2026-10-13T06:59:59Z"))).code).toBe("rule_before_deadline");
    expect((await httpProbe(rule,fetcher,Date.parse("2026-10-13T07:00:00Z"))).code).toBe("daily_deadline_missed");
    expect((await httpProbe(rule,mockFetch(()=>({finishedAt:"2026-10-09T06:00:00Z"})),Date.parse("2026-10-13T06:59:59Z"))).code).toBe("rule_before_deadline");
    expect((await httpProbe(rule,mockFetch(()=>({finishedAt:"2026-10-13T06:00:00Z"})),Date.parse("2026-10-13T07:00:00Z"))).verdict).toBe("pass");
    // Calendar traversal across a year boundary; Friday is the only active day.
    expect(assertionsResult({finishedAt:"2026-12-25T06:00:00Z"},rule.assertions,Date.parse("2027-01-01T06:59:59Z"),rule.timezone,[5]).verdict).toBe("unknown");
  });
  test("off days do not claim health or resolve an existing incident",async()=>{
    const s=store(),rule=validateRule(raw),sat=Date.parse("2026-10-10T07:00:00Z"),sun=Date.parse("2026-10-11T07:00:00Z");
    const failed=await httpProbe(rule,mockFetch(()=>({finishedAt:"2026-10-09T06:00:00Z"})),sat);
    s.observe(failed,sat);const incident=s.activeIncident(rule.id)!;
    const skipped=await httpProbe(rule,mockFetch(()=>{throw new Error("must not fetch");}),sun);
    expect(s.observe(skipped,sun)).toMatchObject({status:"off",verdict:"unknown",successes:0,lastPassedAt:null,enabled:true});
    expect(s.activeIncident(rule.id)?.id).toBe(incident.id);
    expect(s.snapshot("test",sun).checks.find(c=>c.id===rule.id)?.status).toBe("off");
    const fresh=store();fresh.observe(skipped,sun);expect(fresh.activeIncident(rule.id)).toBeUndefined();
  });
});

import { withSpaceToken } from "./probes.ts";
test("the app token goes to Space's own API only", async () => {
  const seen: [string, string | null][] = [];
  const f = withSpaceToken((async (input: RequestInfo | URL, init?: RequestInit) => { seen.push([String(input), new Headers(init?.headers).get("authorization")]); return new Response("{}"); }) as typeof fetch, "http://127.0.0.1:8700", "app-t");
  await f("http://127.0.0.1:8700/api/tasks");
  await f("http://127.0.0.1:8701/api/checks/x");
  await f("http://127.0.0.1:87000/api/x");
  expect(seen).toEqual([["http://127.0.0.1:8700/api/tasks", "Bearer app-t"], ["http://127.0.0.1:8701/api/checks/x", null], ["http://127.0.0.1:87000/api/x", null]]);
});

test("daily rules wait before fetching or checking exists/ok and preserve incidents", async () => {
  const s=store(), rule=validateRule({name:"Daily",url:"http://example.test",timezone:"Asia/Shanghai",weekdays:[2,3,4,5,6],failAfter:1,recoverAfter:1,assertions:[{path:"$.items[0]",operator:"exists"},{path:"$.items[0].ok",operator:"eq",value:true},{path:"$.items[0].finishedAt",operator:"dailyBy",value:"15:00"}]});
  const fail=mockFetch(()=>({items:[{ok:true,finishedAt:"2026-09-29T07:00:00Z"}]}));
  const sat=Date.parse("2026-10-17T07:00:00Z");
  s.observe(await httpProbe(rule,fail,sat),sat);
  const incident=s.activeIncident(rule.id)!.id;
  for (const instant of ["2026-10-19T16:00:00Z","2026-10-20T06:59:59Z"]) {
    const now=Date.parse(instant);
    const sample=await httpProbe(rule,mockFetch(()=>{throw new Error("must not fetch");}),now);
    expect(sample.code).toBe("rule_before_deadline");
    expect(s.observe(sample,now)).toMatchObject({status:"off",successes:0});
    expect(s.activeIncident(rule.id)?.id).toBe(incident);
  }
  const deadline=Date.parse("2026-10-20T07:00:00Z");
  expect((await httpProbe(rule,fail,deadline)).code).toBe("daily_deadline_missed");
  expect((await httpProbe(rule,mockFetch(()=>({items:[]})),deadline)).verdict).toBe("fail");
  const success=await httpProbe(rule,mockFetch(()=>({items:[{ok:true,finishedAt:"2026-10-20T06:00:00Z"}]})),deadline);
  expect(s.observe(success,deadline).status).toBe("healthy");
  expect(s.activeIncident(rule.id)).toBeUndefined();
});

describe("Backups",()=>{
  const now=Date.parse("2026-11-25T12:00:00Z"),iso=(ms:number)=>new Date(ms).toISOString(),H=3600_000;
  const backup=(app:string,state:Task["state"],extra:Partial<Task>={}):Task=>({id:`b-${app}`,app,name:"backup",enabled:true,orphaned:false,timeoutMs:1800_000,createdAt:"2026-11-01T00:00:00Z",state,...extra});
  const verify:Task={id:"verify",app:"space",name:"backup-verify",enabled:true,orphaned:false,timeoutMs:3600_000,state:{lastStatus:"ok",lastRunAt:iso(now-2*24*H),nextRunAt:iso(now+5*24*H),lastDurationMs:60_000}};
  const daily=(lastStatus:string,consecutiveErrors=0)=>({lastStatus,lastRunAt:iso(now-2*H),lastDurationMs:5000,nextRunAt:iso(now+22*H),consecutiveErrors});
  test("a destination is configured when Space registered its own backup tasks",()=>{
    expect(backupConfigured([])).toBe(false);
    expect(backupConfigured([backup("news",daily("ok"))])).toBe(false);
    expect(backupConfigured([{...verify,orphaned:true}])).toBe(false);
    expect(backupConfigured([verify])).toBe(true);
    expect(backupConfigured([{...backup("space",daily("ok"))}])).toBe(true);
  });
  test("a backup whose latest run failed is a fault at once; a stale one too; an operator threshold still applies",()=>{
    const failed=backup("news",daily("error",1)),s=taskSample(failed,DEFAULT_SETTINGS,now);
    expect(s).toMatchObject({verdict:"unknown",transient:true});
    expect(backupSample(s,failed,now-26*H,now)).toMatchObject({verdict:"fail",transient:false,failAfter:1,code:"backup_failed",detail:"Latest backup run failed (1 in a row); last successful run 2026-11-24T10:00Z"});
    expect(backupSample(s,failed,now-26*H,now,{errorThreshold:3})).toBe(s);
    // Twice the daily interval plus the timeout: 48.5 h. Past it, stale wins over the failure, policy or not.
    const stale=backupSample(s,failed,now-49*H,now,{errorThreshold:3});
    expect(stale).toMatchObject({verdict:"fail",failAfter:1,code:"backup_stale",detail:"No successful backup within 49 h (twice its schedule interval plus its timeout); last successful run 2026-11-23T11:00Z"});
    // Nothing succeeded on record: counted from the task's creation. Unknown history never counts as stale.
    expect(backupSample(s,failed,null,now).code).toBe("backup_stale");
    expect(backupSample(s,failed,undefined,now)).toMatchObject({code:"backup_failed",detail:"Latest backup run failed (1 in a row); last successful run unknown"});
    const ok=backup("news",daily("ok"));expect(backupSample(taskSample(ok,DEFAULT_SETTINGS,now),ok,now-2*H,now).code).toBe("task_ok");
    // Overdue, running and other tasks keep their own result.
    const overdue=backup("news",{...daily("error",1),nextRunAt:iso(now-H)});expect(backupSample(taskSample(overdue,DEFAULT_SETTINGS,now),overdue,now-49*H,now).code).toBe("task_overdue");
    const other={...failed,name:"sync"};expect(backupSample(s,other,null,now)).toBe(s);
    const store1=store();expect(store1.observe(backupSample(s,failed,now-26*H,now),now).status).toBe("failing");expect(store1.activeIncident("task:b-news")).toBeDefined();
  });
  function space(tasks:Task[],runs:unknown[]=[]){return mockFetch(url=>url.includes("/runs")?{runs}:url.endsWith("/api/tasks")?{tasks}:url.endsWith("services")?{services:[]}:url.endsWith("/api/checks")?{checks:[]}:{peers:[]});}
  const engine=(s:Store,f:typeof fetch)=>new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},f);
  test("without a destination: one reminder on the snapshot, dashboard, panel card and evidence, never a check or a count",async()=>{
    const s=store(),e=engine(s,space([]));await e.scan();
    const snap=e.snapshot();expect(snap.backup).toMatchObject({configured:false,tasks:0});
    // No check stands for it: the totals count the checks only (host CPU waits for its second sample here).
    expect(snap.checks.filter(c=>/backup/.test(c.id+c.code+c.name))).toHaveLength(0);expect(snap.incidents).toHaveLength(0);
    expect(snap.history.at(-1)).toMatchObject({failing:0,unknown:snap.checks.filter(c=>c.status==="unknown").length});
    const dash=await (await api(e)(new Request("http://ops.test/api/dashboard"))).json() as {notices:unknown[]};
    expect(dash.notices).toEqual([{machine:"local",code:"backup_not_configured",text:"Backup destination not configured",hint:BACKUP_UNCONFIGURED.hint.en}]);
    const w=widget(snap);
    expect(w.items.map(i=>i.text)).toContain("local: Backup destination not configured");
    expect(w.blocks.find(b=>b.type==="status")).toMatchObject({label:{en:"Backups",zh:"备份"},value:{en:"Backup destination not configured",zh:"未配置备份目的地"},tone:"neutral"});
    expect(w.blocks[1]).toMatchObject({type:"metric",value:0,tone:"positive"});
    expect(snapshotEvidence(snap,"local").parts.join("\n")).toContain("## Reminders (not faults, not counted in the checks)\n- Backup destination not configured (backup_not_configured)");
    // A peer's snapshot carries it too; one that predates it, or whose task list is not current, has no reminder.
    expect(widget({...snap,backup:undefined} as Snapshot).items).toHaveLength(1);
    expect(s.snapshot("local",Date.now()+10*60_000,240_000).backup).toBeUndefined();
  });
  test("with a destination: no reminder, and a failed backup opens an incident on the first scan",async()=>{
    const recent=Date.now(),tasks=[verify,{...backup("news",{lastStatus:"error",lastRunAt:new Date(recent-H).toISOString(),lastDurationMs:5000,nextRunAt:new Date(recent+23*H).toISOString(),consecutiveErrors:1}),createdAt:"2026-11-01T00:00:00Z"}];
    const s=store(),e=engine(s,space(tasks,[{status:"error",startedAt:recent-H},{status:"ok",startedAt:recent-25*H,endedAt:recent-25*H+5000}]));await e.scan();
    const snap=e.snapshot();expect(snap.backup).toMatchObject({configured:true,tasks:2});
    expect(widget(snap).blocks.some(b=>JSON.stringify(b.label).includes("Backups"))).toBe(false);
    expect(s.get<{status:string;code:string}>("check","task:b-news")).toMatchObject({status:"failing",code:"backup_failed"});
    expect(s.activeIncident("task:b-news")?.detail).toBe(`Latest backup run failed (1 in a row); last successful run ${new Date(recent-25*H+5000).toISOString().slice(0,16)}Z`);
    expect(s.get<CheckLike>("check","task:verify")?.status).toBe("healthy");
  });
});

describe("Forgetting a check",()=>{
  const post=(handler:ReturnType<typeof api>,id:string)=>handler(new Request(`http://ops.test/api/checks/${encodeURIComponent(id)}/forget`,{method:"POST",headers:{"content-type":"application/json",origin:"http://ops.test"},body:"{}"}));
  test("only a check that is no longer observed is forgotten, with its open incident resolved",async()=>{
    const s=store();let services=[{app:"gone",title:"Gone",status:"active",health:"down"},{app:"here",title:"Here",status:"active",health:"ok"}];
    const e=new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",retentionDays:30},mockFetch(url=>url.endsWith("services")?{services}:url.endsWith("tasks")?{tasks:[]}:{peers:[]}));
    for(let i=0;i<3;i++)await e.scan();
    const incident=s.activeIncident("service:gone")!;expect(incident).toBeDefined();
    const handler=api(e);
    expect((await post(handler,"service:gone")).status).toBe(409);
    expect((await post(handler,"service:here")).status).toBe(409);
    expect((await post(handler,"service:nothing")).status).toBe(404);
    // The app moved off the machine: its check stays not_observed, scan after scan.
    services=services.filter(x=>x.app!=="gone");await e.scan();await e.scan();
    expect(s.get<{status:string;code:string}>("check","service:gone")).toMatchObject({status:"unknown",code:"not_observed"});
    const r=await post(handler,"service:gone");expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ok:true,id:"service:gone",resolvedIncident:incident.id});
    expect(s.get("check","service:gone")).toBeNull();expect(s.activeIncident("service:gone")).toBeUndefined();
    expect(s.incident(incident.id)).toMatchObject({status:"resolved",resolvedBy:"operator"});
    expect(s.incident(incident.id).events.at(-1)).toMatchObject({type:"resolved",detail:"Check forgotten by an operator: its resource is no longer observed"});
    await e.scan();expect(s.get("check","service:gone")).toBeNull();expect(s.get<CheckLike>("check","service:here")?.status).toBe("healthy");
    // A paused leftover is forgotten too; a cross-site write is refused before anything changes.
    services=[];await e.scan();s.control("service:here",{enabled:false});
    expect((await handler(new Request("http://ops.test/api/checks/service%3Ahere/forget",{method:"POST",headers:{"content-type":"application/json",origin:"https://evil.test"},body:"{}"}))).status).toBe(403);
    expect((await post(handler,"service:here")).status).toBe(200);expect(s.get("check","service:here")).toBeNull();
  });
});
