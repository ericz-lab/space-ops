import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { assertionsResult, field, validateRule } from "./rules.ts";
import { httpProbe, taskSample, type Task } from "./probes.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { DEFAULT_SETTINGS, type Sample } from "./types.ts";

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();});
function store(){const s=new Store(":memory:");stores.push(s);return s;}
const sample:Sample={id:"one",name:"API",app:"example",kind:"http",coverage:"assertion",verdict:"fail",code:"failed",detail:"Wrong output"};
const at=Date.parse("2026-10-01T10:00:00Z");
const mockFetch=(fn:(url:string)=>unknown):typeof fetch=>((async(input:RequestInfo|URL)=>Response.json(fn(String(input)))) as typeof fetch);

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
    const s=store();expect(s.observe(sample,at).status).toBe("pending");
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
  function engine(s:Store,f=mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:{peers:[]})){return new Engine(s,{api:"http://space.test",machine:"local",dataDir:"/tmp",intervalMs:60000,retentionDays:30},f);}
  test("source loss changes discovered checks to unknown",async()=>{
    const s=store();let online=true;
    const e=engine(s,mockFetch(url=>{if(!online)throw new Error("offline");return url.endsWith("services")?{services:[{app:"app",title:"App",status:"active",health:"ok"}]}:url.endsWith("tasks")?{tasks:[]}:{peers:[]};}));
    await e.scan();expect(s.get<CheckLike>("check","service:app")?.status).toBe("healthy");
    online=false;await e.scan();expect(s.get<CheckLike>("check","service:app")?.status).toBe("unknown");
  });
  test("peer failure preserves the last snapshot but marks it unknown",async()=>{
    const s=store();let online=true;
    const e=engine(s,mockFetch(url=>{if(url.includes("/proxy/")){if(!online)throw new Error("offline");return{version:1,machine:"remote",generatedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),checks:[],incidents:[],history:[]};}return url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:{peers:[{name:"remote"}]};}));
    await e.scan();expect(e.peers()[0]?.status).toBe("healthy");online=false;await e.scan();expect(e.peers()[0]?.status).toBe("unknown");expect(e.peers()[0]?.snapshot?.machine).toBe("remote");
  });
  test("same-origin JSON is required for mutations",async()=>{
    const s=store(),handler=api(engine(s));
    const request=(origin?:string)=>new Request("http://ops.test/api/rules",{method:"POST",headers:{"content-type":"application/json",...(origin?{origin}:{})},body:JSON.stringify({name:"API",url:"http://example.test"})});
    expect((await handler(request())).status).toBe(403);
    expect((await handler(request("http://evil.test"))).status).toBe(403);
    expect((await handler(request("http://ops.test"))).status).toBe(201);
    await new Promise(r=>setTimeout(r,20));
    expect(s.rules()).toHaveLength(1);
  });
});
type CheckLike={status:string};
