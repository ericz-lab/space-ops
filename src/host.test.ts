import { describe, test, expect, afterEach } from "bun:test";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { api } from "./api.ts";
import { cpuPercent, hostSamples, osCpuTicks, parseLoadavg, parseMeminfo, parseProcStat, readHostResources } from "./probes.ts";
import { DEFAULT_SETTINGS, type HostResources, type Snapshot } from "./types.ts";

const stores:Store[]=[];
afterEach(()=>{for(const s of stores.splice(0))s.db.close();});
function store(){const s=new Store(":memory:");stores.push(s);return s;}
const mockFetch=(fn:(url:string)=>unknown):typeof fetch=>((async(input:RequestInfo|URL)=>Response.json(fn(String(input)))) as typeof fetch);
const spaceFetch=mockFetch(url=>url.endsWith("services")?{services:[]}:url.endsWith("tasks")?{tasks:[]}:url.endsWith("checks")?{checks:[]}:{peers:[]});

const STAT_A=`cpu  10000 200 3000 80000 500 0 100 0 0 0
cpu0 5000 100 1500 40000 250 0 50 0 0 0
cpu1 5000 100 1500 40000 250 0 50 0 0 0
intr 1234 0 0
ctxt 99999
btime 1700000000
`;
// 1000 more jiffies in all; 250 of them idle+iowait: 75 % busy.
const STAT_B=STAT_A.replace("cpu  10000 200 3000 80000 500 0 100 0 0 0","cpu  10600 200 3100 80200 550 0 150 0 0 0");
const MEMINFO=`MemTotal:       16000000 kB
MemFree:         2000000 kB
MemAvailable:    6000000 kB
Buffers:          500000 kB
Cached:          3000000 kB
SwapTotal:             0 kB
`;
const resources:HostResources={sampledAt:"2026-10-01T10:00:00Z",cpu:{percent:50,cores:4,intervalMs:300_000,source:"proc"},load:{one:1,five:1,fifteen:1},memory:{usedBytes:10e9,totalBytes:16e9,availableBytes:6e9,percent:62.5,source:"proc"},disk:{usedBytes:40e9,totalBytes:100e9,percent:40,path:"/data"}};

describe("Host resource parsing",()=>{
  test("/proc/stat aggregate line sums the first eight fields; idle includes iowait",()=>{
    const t=parseProcStat(STAT_A,1000)!;
    expect(t).toEqual({idle:80500,total:93800,at:1000});
    expect(parseProcStat("intr 1 2 3")).toBeNull();
    expect(parseProcStat("cpu  1 x 3 4")).toBeNull();
  });
  test("CPU percent is the busy share between two samples and refuses counters that went backwards",()=>{
    expect(cpuPercent(parseProcStat(STAT_A,0)!,parseProcStat(STAT_B,1000)!)).toBe(75);
    expect(cpuPercent(parseProcStat(STAT_A,0)!,parseProcStat(STAT_A,1000)!)).toBeNull();
    expect(cpuPercent(parseProcStat(STAT_B,0)!,parseProcStat(STAT_A,1000)!)).toBeNull();
    const os=osCpuTicks();expect(os.total).toBeGreaterThan(0);expect(os.idle).toBeLessThanOrEqual(os.total);
  });
  test("/proc/loadavg and /proc/meminfo fixtures",()=>{
    expect(parseLoadavg("0.52 0.58 0.59 2/1234 56789\n")).toEqual({one:0.52,five:0.58,fifteen:0.59});
    expect(parseLoadavg("garbage")).toBeNull();
    expect(parseMeminfo(MEMINFO)).toEqual({totalBytes:16000000*1024,availableBytes:6000000*1024});
    expect(parseMeminfo("MemTotal:  10 kB\n")).toBeNull();
    expect(parseMeminfo("MemTotal:  10 kB\nMemAvailable:  20 kB\n")).toBeNull();
  });
  test("a live reading has load, memory and disk; CPU appears only with a previous sample or a settle delay",async()=>{
    const first=await readHostResources(import.meta.dir,null);
    expect(first.resources.cpu).toBeUndefined();expect(first.resources.load).toBeDefined();expect(first.resources.memory!.percent).toBeGreaterThan(0);expect(first.resources.disk!.totalBytes).toBeGreaterThan(0);
    const second=await readHostResources(import.meta.dir,{...first.ticks,at:first.ticks.at-1000,total:first.ticks.total-100,idle:first.ticks.idle-50});
    expect(second.resources.cpu!.percent).toBeGreaterThanOrEqual(0);expect(second.resources.cpu!.percent).toBeLessThanOrEqual(100);
    const settled=await readHostResources(import.meta.dir,null,30);
    expect(settled.resources.cpu).toBeDefined();expect(settled.resources.cpu!.intervalMs).toBeGreaterThanOrEqual(25);
  });
});
describe("Host checks",()=>{
  test("CPU above the threshold fails, below passes, unmeasured is unknown and never passing",()=>{
    const cpu=(r:HostResources)=>hostSamples(r,{...DEFAULT_SETTINGS,cpuPercent:90}).find(s=>s.id==="host:cpu")!;
    expect(cpu(resources)).toMatchObject({verdict:"pass",code:"host_cpu",value:50,threshold:90,coverage:"host"});
    expect(cpu({...resources,cpu:{...resources.cpu!,percent:90}})).toMatchObject({verdict:"fail",value:90});
    expect(cpu({...resources,cpu:undefined})).toMatchObject({verdict:"unknown",code:"host_cpu_unknown"});
    const low=hostSamples({...resources,cpu:{...resources.cpu!,percent:91}},{...DEFAULT_SETTINGS,cpuPercent:95}).find(s=>s.id==="host:cpu")!;
    expect(low.verdict).toBe("pass");
  });
  test("memory, load and disk checks keep their thresholds; a missing number is unknown",()=>{
    const by=(r:HostResources,s=DEFAULT_SETTINGS)=>Object.fromEntries(hostSamples(r,s).map(x=>[x.id,x]));
    expect(by(resources)["host:memory"]).toMatchObject({verdict:"pass",value:62.5,threshold:95});
    expect(by(resources,{...DEFAULT_SETTINGS,memoryPercent:60})["host:memory"]!.verdict).toBe("fail");
    expect(by(resources)["host:load"]).toMatchObject({verdict:"pass",value:1,threshold:8});
    expect(by({...resources,load:{one:9,five:1,fifteen:1}})["host:load"]!.verdict).toBe("fail");
    expect(by(resources)["host:disk"]).toMatchObject({verdict:"pass",value:40,threshold:90});
    expect(by({...resources,disk:undefined})["host:disk"]).toMatchObject({verdict:"unknown",code:"host_disk_unknown"});
    expect(by({...resources,memory:undefined})["host:memory"]).toMatchObject({verdict:"unknown",code:"host_memory_unknown"});
  });
  test("a scan stores the measurement and the snapshot carries it under version 1",async()=>{
    const s=store(),e=new Engine(s,{api:"http://space.test",machine:"local",dataDir:import.meta.dir,retentionDays:30},spaceFetch);
    await e.scan();
    const snap=e.snapshot();
    expect(snap.version).toBe(1);
    expect(snap.resources?.memory?.totalBytes).toBeGreaterThan(0);expect(snap.resources?.disk?.percent).toBeGreaterThanOrEqual(0);expect(Number.isFinite(Date.parse(snap.resources!.sampledAt))).toBe(true);
    expect(snap.checks.find(c=>c.id==="host:cpu")?.status).toBe("unknown");
    await e.scan();
    expect(e.snapshot().resources?.cpu?.percent).toBeGreaterThanOrEqual(0);
    expect(["healthy","failing","transient"]).toContain(e.snapshot().checks.find(c=>c.id==="host:cpu")?.status??"");
    const dash=await (await api(e)(new Request("http://127.0.0.1:8998/api/dashboard"))).json() as {local:Snapshot;settings:{cpuPercent:number}};
    expect(dash.local.resources?.cpu).toBeDefined();expect(dash.settings.cpuPercent).toBe(90);
  });
  test("the CPU threshold is a validated setting",async()=>{
    const s=store(),handler=api(new Engine(s,{api:"http://space.test",machine:"local",dataDir:import.meta.dir,retentionDays:30},spaceFetch));
    const put=(body:unknown)=>handler(new Request("http://127.0.0.1:8998/api/settings",{method:"PUT",headers:{origin:"http://127.0.0.1:8998","content-type":"application/json"},body:JSON.stringify(body)}));
    expect((await put({cpuPercent:49})).status).toBe(400);
    expect((await put({cpuPercent:80})).status).toBe(200);
    expect(s.settings().cpuPercent).toBe(80);
    expect(hostSamples({...resources,cpu:{...resources.cpu!,percent:85}},s.settings()).find(x=>x.id==="host:cpu")!.verdict).toBe("fail");
  });
});
