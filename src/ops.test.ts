import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "./store.ts";
import { assertionsResult, field, validateRule } from "./rules.ts";
import { declaredNoop, httpProbe, repeatedSkip, taskSample, withRecoveryEvidence, type Task } from "./probes.ts";
import { Engine } from "./engine.ts";
import { api, widget } from "./api.ts";
import { DEFAULT_SETTINGS, type DeclaredCheck, type Sample } from "./types.ts";
import { declared, evaluate, inspect } from "./inspections.ts";

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
  test("a peer no longer configured (removed or renamed) is forgotten and its check retired",async()=>{
    const s=store();let peers=[{name:"old-name"}];let online=true;
    const e=engine(s,mockFetch(url=>{if(url.includes("/proxy/"))return{version:1,machine:"remote",generatedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),checks:[],incidents:[],history:[]};if(url.endsWith("peers")){if(!online)throw new Error("offline");return{peers};}return url.endsWith("services")?{services:[]}:{tasks:[]};}));
    await e.scan();expect(e.peers().map(p=>p.name)).toEqual(["old-name"]);
    // An unreadable peer list removes nothing.
    online=false;peers=[{name:"new-name"}];await e.scan();expect(e.peers().map(p=>p.name)).toEqual(["old-name"]);
    online=true;await e.scan();
    expect(e.peers().map(p=>p.name)).toEqual(["new-name"]);expect(s.get<CheckLike>("check","peer:old-name")).toBeNull();expect(s.get<CheckLike>("check","peer:new-name")?.status).toBe("healthy");
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
