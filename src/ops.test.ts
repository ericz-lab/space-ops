import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { assertionsResult, field, validateRule } from "./rules.ts";
import { httpProbe, taskSample, withRecoveryEvidence, type Task } from "./probes.ts";
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
  const rule=validateRule({name:"Completion",url:"http://example.test/status",recoveryTaskId:"task-1",evidenceTimestampPath:"$.finishedAt",assertions:[{path:"$.ok",operator:"eq",value:true}]});
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
