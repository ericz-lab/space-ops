import { describe, test, expect, afterEach } from "bun:test";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { Diagnosis, collectEvidence, parseAnswer, peerEvidence } from "./diagnose.ts";
import { markdown } from "../web/markdown.ts";
import type { PeerView, Report, Sample, Snapshot } from "./types.ts";

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();});
function store(){const s=new Store(":memory:");stores.push(s);return s;}
const task:Sample={id:"task:t1",name:"news / fetch",app:"news",kind:"task",coverage:"execution",verdict:"fail",failAfter:1,code:"task_errors",detail:"3 consecutive failed executions"};
type Seen={url:string;body?:Record<string,unknown>;auth?:string};
/** Space stand-in: task runs, the model ledger and the model service. */
function space(answer:(body:Record<string,unknown>)=>{status?:number;body:unknown},seen:Seen[]=[]):typeof fetch{
  return (async(input:RequestInfo|URL,init?:RequestInit)=>{
    const url=String(input),body=init?.body?JSON.parse(String(init.body)):undefined;seen.push({url,body,auth:new Headers(init?.headers).get("authorization")??undefined});
    if(url.includes("/runs"))return Response.json({runs:[{status:"error",startedAt:Date.now()-60_000,endedAt:Date.now()-50_000,error:"ECONNREFUSED upstream"}]});
    if(url.includes("/api/model/calls"))return Response.json({calls:[{app:"news",tag:"digest",model:"m",status:"error",error:"rate limited",startedAt:new Date().toISOString()},{app:"news",tag:"digest",model:"m",status:"ok",startedAt:new Date().toISOString()}]});
    if(url.endsWith("/proxy/api/evidence"))return Response.json({ok:true,version:1,machine:"david",generatedAt:new Date().toISOString(),text:"## Checks not healthy (1)\n- [failing] picker / sync: upstream 503",coverage:[{name:"Service logs",status:"done",detail:"Logs of 1 of 1 applications"}],targets:["david/picker"]});
    if(url.endsWith("/api/model/run")){const a=answer(body);return Response.json(a.body,{status:a.status??200});}
    return Response.json({});
  }) as typeof fetch;
}
const engine=(s:Store,f:typeof fetch,token:string|null="app-token")=>new Engine(s,{api:"http://space.test",machine:"seoul",dataDir:"/tmp",retentionDays:30,appToken:token??undefined},f);

describe("Diagnosis",()=>{
  test("evidence names every source, and logs it could not read are marked as not checked",async()=>{
    const s=store();s.observe(task);s.finishScan();
    const e=engine(s,space(()=>({body:{}})));
    const without=await collectEvidence(e);
    expect(without.text).toContain("ECONNREFUSED upstream");
    expect(without.text).toContain("news/digest (m): 1 failed");
    expect(without.text).toContain("[failing] news / fetch");
    expect(without.targets).toEqual(["seoul/news"]);
    expect(without.coverage.find(c=>c.name==="Service logs")).toMatchObject({status:"skipped"});
    expect(without.coverage.find(c=>c.name==="Failed task runs")).toMatchObject({status:"done"});
    const cmds:string[]=[];
    const withLogs=await collectEvidence(e,{logsCommand:"journal -u space-{app}.service -n {lines}",run:async cmd=>{cmds.push(cmd);return {code:0,out:"line one\nboom: disk full"};}});
    expect(cmds).toEqual(["journal -u space-news.service -n 60"]);
    expect(withLogs.text).toContain("boom: disk full");
    expect(withLogs.coverage.find(c=>c.name==="Service logs")).toMatchObject({status:"done"});
  });
  test("a healthy machine has nothing to read beyond the checks",async()=>{
    const s=store();s.observe({...task,verdict:"pass",code:"task_ok"});s.finishScan();
    const ev=await collectEvidence(engine(s,space(()=>({body:{}}))));
    expect(ev.coverage.find(c=>c.name==="Service logs")).toMatchObject({status:"done"});
    expect(ev.text).toContain("## Checks not healthy (0)");
    s.observe({...task,id:"task:t2",name:"news / digest",verdict:"unknown",code:"task_running"});
    expect((await collectEvidence(engine(s,space(()=>({body:{}}))))).text).toContain("Tasks running now, within their deadline (counted as unknown, not a fault)\n- news / digest (news)");
  });
  test("parses the verdict and summary lines and keeps the rest as the report",()=>{
    expect(parseAnswer("VERDICT: issues\nSUMMARY: news fetch fails\n\n## 结论\nBroken")).toEqual({verdict:"issues",summary:"news fetch fails",body:"## 结论\nBroken"});
    expect(parseAnswer("**VERDICT:** ok\n**SUMMARY:** 一切正常\n## 结论\nok").verdict).toBe("ok");
    expect(parseAnswer("## 结论\nNo header at all")).toMatchObject({verdict:"incomplete",summary:"No header at all"});
  });
  test("one run at a time, persisted with its call and the tier left to the space",async()=>{
    const s=store();s.observe(task);s.finishScan();const seen:Seen[]=[];
    let release!:()=>void;const gate=new Promise<void>(r=>release=r);
    const f=space(()=>({body:{ok:true,text:"VERDICT: issues\nSUMMARY: news fetch fails\n## 结论\nx",call:{id:7,model:"gpt-6-astra",runtime:"codex",durationMs:900}}}),seen);
    const slow=(async(i:RequestInfo|URL,init?:RequestInit)=>{if(String(i).endsWith("/api/model/run"))await gate;return f(i,init);}) as typeof fetch;
    const d=new Diagnosis(engine(s,slow));
    const first=d.start("zh","ops@example.com");expect(first.started).toBe(true);
    const second=d.start("zh");expect(second.started).toBe(false);expect(second.report.id).toBe(first.report.id);
    release();await d.settled();
    const r=s.report(first.report.id)!;
    expect(r).toMatchObject({status:"done",verdict:"issues",summary:"news fetch fails",by:"ops@example.com",call:{id:7,model:"gpt-6-astra"}});
    expect(r.finishedAt).not.toBeNull();
    const run=seen.find(x=>x.url.endsWith("/api/model/run"))!;
    expect(run.auth).toBe("Bearer app-token");
    expect(run.body).toMatchObject({tag:"diagnose"});expect(run.body!.model).toBeUndefined();
    expect(String(run.body!.prompt)).toContain("简体中文");
    expect(s.reports()[0]).not.toHaveProperty("body");
  });
  test("a failed model call is a failed report with its reason; a restart fails a running one",async()=>{
    const s=store();s.finishScan();
    const d=new Diagnosis(engine(s,space(()=>({status:502,body:{ok:false,error:"codex: not logged in",call:{id:9}}}))));
    const {report}=d.start("en");await d.settled();
    expect(s.report(report.id)).toMatchObject({status:"failed",error:"codex: not logged in"});
    const running:Report={id:"r1",machine:"seoul",status:"running",lang:"en",startedAt:new Date().toISOString(),finishedAt:null,targets:["seoul"],coverage:[]};
    s.putReport(running);s.interruptReports();
    expect(s.report("r1")).toMatchObject({status:"failed"});expect(s.report("r1")!.error).toContain("restarted");
  });
  test("without the app token it refuses instead of starting",()=>{
    const s=store();expect(()=>new Diagnosis(engine(s,space(()=>({body:{}})),null)).start("en")).toThrow("credentials");
    expect(s.reports()).toHaveLength(0);
  });
  test("API: start, refuse a second click, list and read",async()=>{
    const s=store();s.finishScan();
    const e=engine(s,space(()=>({body:{ok:true,text:"VERDICT: ok\nSUMMARY: fine\nbody"}}))),d=new Diagnosis(e),handler=api(e,d);
    const post=()=>handler(new Request("http://ops.test/api/reports",{method:"POST",headers:{"content-type":"application/json",origin:"http://ops.test"},body:JSON.stringify({lang:"zh"})}));
    const a=await post();expect(a.status).toBe(202);const id=(await a.json()).report.id;
    expect((await post()).status).toBe(409);
    await d.settled();
    expect((await (await handler(new Request("http://ops.test/api/reports"))).json()).reports[0]).toMatchObject({id,status:"done",verdict:"ok"});
    expect((await (await handler(new Request(`http://ops.test/api/reports/${id}`))).json()).report.body).toBe("body");
    expect((await handler(new Request("http://ops.test/api/reports/none"))).status).toBe(404);
    const dash=await (await handler(new Request("http://ops.test/api/dashboard"))).json();
    expect(dash.diagnosisReady).toBe(true);expect(dash.reports).toHaveLength(1);
  });
});

const peerSnap=(machine:string):Snapshot=>({version:1,machine,generatedAt:new Date().toISOString(),lastScanAt:new Date().toISOString(),staleAfterMs:240000,checks:[{id:"task:x",name:"picker / sync",app:"picker",kind:"task",coverage:"execution",verdict:"fail",code:"task_errors",detail:"4 consecutive failed executions",status:"failing",failures:4,successes:0,observedAt:new Date().toISOString(),lastPassedAt:null,mutedUntil:null,enabled:true}],incidents:[],history:[]});
const peer=(over:Partial<PeerView>={}):PeerView=>({name:"david",url:"http://space.test/api/peers/david/apps/space-ops/proxy/api/snapshot",status:"healthy",snapshot:peerSnap("david"),receivedAt:new Date().toISOString(),...over});

describe("Diagnosis of peers",()=>{
  test("a peer's own evidence is read through the peer proxy next to its snapshot",async()=>{
    const seen:Seen[]=[],ev=await peerEvidence(engine(store(),space(()=>({body:{}}),seen)),peer());
    expect(seen[0]!.url).toBe("http://space.test/api/peers/david/apps/space-ops/proxy/api/evidence");
    expect(ev.text).toContain("upstream 503");expect(ev.targets).toEqual(["david/picker"]);
  });
  test("without its evidence a peer falls back to its snapshot and says what was not read",async()=>{
    const failing=(async()=>new Response("no",{status:404})) as unknown as typeof fetch;
    const ev=await peerEvidence(engine(store(),failing),peer());
    expect(ev.text).toContain("[failing] picker / sync");
    expect(ev.coverage.find(c=>c.name==="Peer evidence")).toMatchObject({status:"partial"});
    expect(ev.coverage.find(c=>c.name==="Peer evidence")!.detail).toContain("HTTP 404");
    const none=await peerEvidence(engine(store(),failing),peer({snapshot:null,status:"unknown",error:"Peer collector is unavailable"}));
    expect(none.coverage[0]).toMatchObject({name:"Peer evidence",status:"failed"});
  });
  test("all machines by default, one when named; every machine's evidence goes to the model",async()=>{
    const s=store();s.observe(task);s.finishScan();s.put("peer","david",peer());const seen:Seen[]=[];
    const d=new Diagnosis(engine(s,space(()=>({body:{ok:true,text:"VERDICT: issues\nSUMMARY: x\nbody"}}),seen)));
    expect(d.scope()).toEqual(["seoul","david"]);expect(d.scope("david")).toEqual(["david"]);expect(()=>d.scope("nowhere")).toThrow("Unknown machine");
    const {report}=d.start("en");await d.settled();
    const r=s.report(report.id)!,prompt=String(seen.find(x=>x.url.endsWith("/api/model/run"))!.body!.prompt);
    expect(r.machines).toEqual(["seoul","david"]);expect(r.targets).toEqual(["seoul","david","seoul/news","david/picker"]);
    expect(r.coverage.filter(c=>c.machine==="david").map(c=>c.name)).toEqual(["Service logs"]);
    expect(prompt).toContain("# Machine: seoul (the collector running this diagnosis)");expect(prompt).toContain("# Machine: david (peer)");expect(prompt).toContain("upstream 503");expect(prompt).toContain("- Service logs: done (Logs of 1 of 1 applications)");expect(prompt).toContain("- Service logs: skipped");
    const only=d.start("en",undefined,"david");await d.settled();
    expect(s.report(only.report.id)!.coverage.every(c=>c.machine==="david")).toBe(true);
  });
  test("GET /api/evidence answers this machine only and reuses a fresh collection",async()=>{
    const s=store();s.observe(task);s.finishScan();s.put("peer","david",peer());const seen:Seen[]=[];
    const e=engine(s,space(()=>({body:{}}),seen)),handler=api(e,new Diagnosis(e));
    const a=await (await handler(new Request("http://ops.test/api/evidence"))).json();
    expect(a).toMatchObject({ok:true,version:1,machine:"seoul"});expect(a.text).not.toContain("david");
    const reads=seen.length;await handler(new Request("http://ops.test/api/evidence"));expect(seen.length).toBe(reads);
  });
});

describe("Report markdown",()=>{
  test("renders the subset and never passes markup through",()=>{
    const html=markdown("## 发现\n- **严重** `code`\n<img src=x onerror=alert(1)>\n```\n<b>raw</b>\n```");
    expect(html).toContain("<h3>发现</h3>");expect(html).toContain("<li><strong>严重</strong> <code>code</code></li>");
    expect(html).not.toContain("<img");expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
  });
});
