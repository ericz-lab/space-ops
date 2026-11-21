import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import page from "../web/index.html";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { withSpaceToken } from "./probes.ts";
import { api } from "./api.ts";
import { Diagnosis } from "./diagnose.ts";

// The bundled release (dist/index.js, `bun run build`) finds its page's files from the working directory: run in its own.
if(!Bun.main.endsWith(".ts"))process.chdir(import.meta.dir);
const dir=process.env.SPACE_APP_DATA_DIR || join(import.meta.dir,"../data");
mkdirSync(dir,{recursive:true});
const database=process.env.DATABASE_URL?.replace(/^sqlite:\/\//,"") || join(dir,"main.db");
mkdirSync(dirname(database),{recursive:true});
const store=new Store(database);
const retentionDays=Number(process.env.OPS_RETENTION_DAYS??30);
if(process.env.OPS_INTERVAL_MS)console.warn("[ops] OPS_INTERVAL_MS is ignored; set the scan interval in Settings");
if(!Number.isInteger(retentionDays)||retentionDays<1||retentionDays>365)throw new Error("OPS_RETENTION_DAYS must be 1–365");
const peers=JSON.parse(process.env.OPS_PEERS??"[]") as {name:string;url:string}[];
if(!Array.isArray(peers)||peers.some(p=>typeof p.name!=="string"||!/^https?:\/\//.test(p.url)))throw new Error("Invalid OPS_PEERS");
const spaceApi=(process.env.SPACE_API_URL??"http://127.0.0.1:8700").replace(/\/$/,"");
const engine=new Engine(store,{api:spaceApi,machine:process.env.SPACE_NAME||hostname(),dataDir:dir,retentionDays,appToken:process.env.SPACE_APP_TOKEN,peers,cpuSettleMs:1000},withSpaceToken(fetch,spaceApi,process.env.SPACE_APP_TOKEN));
store.interruptReports();
const diagnosis=new Diagnosis(engine,{logsCommand:process.env.OPS_LOGS_COMMAND?.trim()||undefined});
const handler=api(engine,diagnosis);
/** A bundled release serves the page's hashed pictures (the favicon) from beside the bundle; from source the page's routes do. */
async function picture(req:Request):Promise<Response>{
  const path=new URL(req.url).pathname;
  if(/^\/[A-Za-z0-9_-]+-[a-z0-9]{8}\.(png|svg|webp|ico|jpg)$/.test(path)){const file=Bun.file(join(import.meta.dir,path.slice(1)));if(await file.exists())return new Response(file,{headers:{"cache-control":"max-age=31536000, immutable"}});}
  return new Response("Not found",{status:404});
}
const server=Bun.serve({hostname:"127.0.0.1",port:Number(process.env.PORT??8998),maxRequestBodySize:32768,routes:{"/":page,"/icon.png":()=>new Response(Bun.file(join(import.meta.dir,"../icon.png"))),"/healthz":handler,"/api/*":handler},fetch:picture,development:process.env.SPACE_DEV==="1"});
engine.start();
// The port this process was given (ai-space assigns one to a package): src/inspect.ts reads it here.
if(process.env.SPACE_APP_DATA_DIR)await Bun.write(join(dir,"service.port"),String(server.port));
console.log(`Space Ops listening on ${server.url}`);
process.on("SIGTERM",()=>{engine.stop();server.stop(true);store.db.close();process.exit(0);});
process.on("SIGINT",()=>{engine.stop();server.stop(true);store.db.close();process.exit(0);});
