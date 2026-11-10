import type { Check, HostResources, Incident, Inspection, PeerView, Report, ReportItem, Rule, ScanRecord, Settings, Snapshot, Status, TaskPolicy } from "../src/types.ts";
import { markdown } from "./markdown.ts";
import { roomScene, bindRoom, type RackMachine } from "./room.ts";
import { t, tn, lang, setLang, ago, until, date, type Key } from "./i18n.ts";

// Space Tiles (ai-space docs/ui-kit.md): the page is drawn with the kit's sp- classes; style.css holds only this app's rules.
const paths: Record<string,string> = {
  pulse:'<path d="M2 12h4.5l2.5-7 4.5 14 2.5-7H22"/>',bell:'<path d="M18 9a6 6 0 0 0-12 0c0 6.5-2.5 7.5-2.5 8.5h17c0-1-2.5-2-2.5-8.5M10 21h4"/>',
  moon:'<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',sun:'<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  auto:'<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',menu:'<path d="M4 7h16M4 12h16M4 17h16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',chevron:'<path d="m9.5 6 6 6-6 6"/>',check:'<path d="m5 12.5 4.5 4.5L19 7"/>',refresh:'<path d="M20 5v5h-5M4 19v-5h5M19.4 10A8 8 0 0 0 5.3 7.3M4.6 14a8 8 0 0 0 14.1 2.7"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',close:'<path d="m7 7 10 10M7 17 17 7"/>',
  shield:'<path d="M12 2.5 19.5 5.5v6c0 5-3.4 8.6-7.5 10-4.1-1.4-7.5-5-7.5-10v-6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  warn:'<path d="M12 3.5 22 20.5H2z"/><path d="M12 10v4.5M12 17.5h.01"/>',info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5h.01"/>',
  download:'<path d="M12 3.5V15m-4.5-4.5L12 15l4.5-4.5M4.5 16.5v4h15v-4"/>',
  doc:'<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',spark:'<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  clipboard:'<rect x="5" y="4" width="14" height="17" rx="2.5"/><path d="M9 4V3h6v1M8.5 12l2.5 2.5 4.5-5"/>',
};
const icon=(name:string,cls="")=>`<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]??paths.pulse}</svg>`;
const esc=(s:unknown)=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
type Dashboard={local:Snapshot;peers:PeerView[];rules:Rule[];settings:Settings;taskPolicies?:Record<string,TaskPolicy>;busy:boolean;reports?:ReportItem[];diagnosisReady?:boolean;scan?:{intervalMs:number;nextAt:string|null};notificationReady:boolean;notificationQueue:{pending:number;failed:number}};
type Listed=Check&{machine:string;remote:boolean};
type ListedIncident=Incident&{machine:string;remote:boolean};
/** What a row shows: the stored status, plus a running task apart from missing evidence. */
type Shown=Exclude<Status,"unknown">|"unknown"|"running";
const PAGES=["overview","checks","incidents","inspections","room","reports","settings"] as const;
const SCAN_CHOICES=[1,2,5,10,15,30,60];
const DAY=86_400_000;
let data:Dashboard|null=null,page=(location.hash.slice(1)||"overview"),machine="all",filter="all",query="",inspQuery="",offline=false;
/** The tab open in the overview's Watching tile, kept across visits. */
let signalTab=(()=>{try{return localStorage.getItem("ops-signal-tab")??"";}catch{return "";}})();
/** The incident in the overview's right column (`id@machine`), and the check or incident whose detail was opened last. */
let asideKey="",selectedKey="";
/** Unsent repair notes by incident, so the 15 s refresh never drops what is being typed. */
const drafts=new Map<string,string>();
const root=document.querySelector<HTMLElement>("#app")!,overlay=document.querySelector<HTMLElement>("#overlay")!;
let refreshPending=false;

// A peer on an older release still reports a sub-threshold failure as "pending".
function shown(c:Check):Shown{const s=c.status as string;return s==="pending"?"transient":s==="unknown"&&c.code==="task_running"?"running":s as Shown;}
/** Kit badge tone of every state word: green passes, amber warns, red is a fault, ink is in progress, grey is not known or not due. */
const tone:Record<string,string>={failed:"bad",failing:"bad",open:"bad",acknowledged:"bad",late:"warn",transient:"warn",healthy:"ok",resolved:"ok",cleared:"ok",done:"ok",recovering:"run",running:"run",unknown:"off",paused:"off",off:"off",pending:"off",skipped:"off"};
function badge(status:string,label=t((status==="off"?"notScheduled":status) as Key)??status){return `<span class="sp-badge ${tone[status]??"off"}">${esc(label)}</span>`;}
const sevBadge=(s:"warning"|"critical")=>`<span class="sp-badge ${s==="critical"?"bad":"warn"}">${t(s)}</span>`;
const chip=(s:string)=>`<span class="sp-chip">${esc(s)}</span>`;
const kindWord=(kind:string)=>t(kind as Key)??kind;
const keyOf=(id:string,host:string)=>`${id}@${host}`;
function localFresh(){return !offline && !!data?.local.lastScanAt && Date.now()-Date.parse(data.local.lastScanAt)<(data.local.staleAfterMs??240000);}
function checks():Listed[]{if(!data)return[];return [...data.local.checks.map(c=>({...c,machine:data!.local.machine,remote:false,...(!localFresh()?{status:"unknown" as Status,code:"stale_observation",detail:t("stale")}:{})})),...data.peers.flatMap(p=>(p.snapshot?.checks??[]).map(c=>({...c,machine:p.name,remote:true,...(p.status==="unknown"?{status:"unknown" as Status,code:"stale_observation",detail:p.error??t("stale")}:{})})))].filter(c=>machine==="all"||c.machine===machine);}
function incidents():ListedIncident[]{if(!data)return[];return [...data.local.incidents.map(i=>({...i,machine:data!.local.machine,remote:false})),...data.peers.flatMap(p=>(p.snapshot?.incidents??[]).map(i=>({...i,machine:p.name,remote:true})))].filter(i=>machine==="all"||i.machine===machine).sort((a,b)=>b.openedAt.localeCompare(a.openedAt));}
/** Checks that failed within a day, stayed under the incident threshold and pass again. */
function cleared(cs:Listed[],is:ListedIncident[]){return cs.filter(c=>shown(c)==="healthy"&&c.failedAt&&Date.now()-Date.parse(c.failedAt)<DAY&&!is.some(i=>i.checkId===c.id&&i.machine===c.machine&&i.openedAt>=c.failedAt!));}
const matches=(c:Listed,f:string)=>{const s=shown(c);return f==="all"||(f==="attention"?s==="failing"||s==="recovering":s===f);};
async function request(path:string,method="GET",body?:unknown){const r=await fetch(path,{method,headers:body===undefined?{}:{"content-type":"application/json"},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();if(!r.ok||d.ok===false)throw new Error(d.error??`HTTP ${r.status}`);return d;}
let toastTimer:ReturnType<typeof setTimeout>|undefined;
function toast(message:string,error=false){const el=document.querySelector<HTMLElement>("#toast")!;el.textContent=message;el.classList.toggle("err",error);el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),3000);}
let reportPoll:ReturnType<typeof setTimeout>|undefined,openReport:string|null=null;
const diagnosing=()=>data?.reports?.find(r=>r.status==="running");
async function load(){if(refreshPending)return;refreshPending=true;const before=diagnosing()?.id;try{data=await request("/api/dashboard");offline=false;}catch{offline=true;}finally{refreshPending=false;}
  // While a diagnosis runs, follow it every few seconds; an open dialog of it is redrawn when it ends.
  clearTimeout(reportPoll);if(diagnosing())reportPoll=setTimeout(()=>void load(),4000);
  if(before&&!diagnosing()){const done=data?.reports?.find(r=>r.id===before);if(done)toast(t(done.status==="done"?"diagnoseDone":"diagnoseFailed"),done.status!=="done");if(openReport===before&&document.querySelector("dialog[open]"))void showReport(before);}
  if(!document.querySelector("dialog[open]")&&!root.contains(document.activeElement?.closest("input,select,textarea")??null))render();}
function navigate(p:string,f="all"){page=p;location.hash=p;filter=f;render();closeDrawers();scrollTo({top:0});}
const scanMinutes=()=>Math.round((data?.scan?.intervalMs??(data?.settings.scanMinutes??5)*60_000)/60_000);
function scanLine(){return `${t("lastScan")} ${ago(data?.local.lastScanAt)} · ${tn("everyMinutes",scanMinutes())}${data?.scan?.nextAt?` · ${t("nextScan")} ${until(data.scan.nextAt)}`:""}`;}
/** How long an incident has been open, as a number and its unit. */
function lasted(from:string):[number,string]{const m=Math.max(0,(Date.now()-Date.parse(from))/60_000);return m<60?[Math.floor(m),t("durMin")]:m<2880?[Math.floor(m/60),t("durHour")]:[Math.floor(m/1440),t("durDay")];}

// ---------------------------------------------------------------- drawers (classes on body, docs/ui-kit.md)
function openDrawer(cls:"sp-open-nav"|"sp-open-aside"){document.body.classList.remove("sp-open-nav","sp-open-aside");document.body.classList.add(cls,"sp-sheet-open");}
function closeDrawers(){document.body.classList.remove("sp-open-nav","sp-open-aside","sp-sheet-open");}
for(const q of ["(min-width: 1200px)","(min-width: 960px)"])matchMedia(q).addEventListener("change",e=>{if(e.matches)closeDrawers();});
document.querySelector(".sp-scrim")?.addEventListener("click",closeDrawers);
document.addEventListener("keydown",e=>{
  const typing=(e.target as HTMLElement).closest?.("input,textarea,select");
  if(e.key==="/"&&!typing&&!document.querySelector("dialog[open]")){e.preventDefault();if(!matchMedia("(min-width: 960px)").matches)openDrawer("sp-open-nav");root.querySelector<HTMLInputElement>("#q")?.focus();}
  if(e.key==="Escape"&&document.body.classList.contains("sp-sheet-open")&&!document.querySelector("dialog[open]"))closeDrawers();
});

// ---------------------------------------------------------------- the shell
function render(){
  if(!PAGES.includes(page as typeof PAGES[number]))page="overview";
  const scrolls=[".sp-side-scroll",".sp-aside-body"].map(s=>root.querySelector(s)?.scrollTop??0);
  const all=incidents(),open=all.filter(i=>i.status!=="resolved");
  const aside=page==="overview"&&data&&!offline?pickAside(open):undefined;
  document.documentElement.lang=lang==="zh"?"zh-CN":"en";
  const body=!data?`${head(t(page as Key),pageSub())}${offline?banner():""}<section class="sp-tile"><div class="sp-state"><span class="ico">${icon("refresh")}</span><h2>${t("noData")}</h2></div></section>`
    :page==="overview"?overview():page==="room"?roomPage():page==="checks"?checksPage():page==="inspections"?inspectionPage():page==="incidents"?incidentPage():page==="reports"?reportsPage():settingsPage();
  root.innerHTML=`<div class="sp-app">${side(open.length)}<div class="sp-work ${aside?"has-aside":""}"><main class="sp-center" id="main">
<div class="sp-mbar"><button type="button" class="sp-icon-btn" data-nav-open aria-label="${t("mobileMenu")}">${icon("menu")}</button><strong>${t(page as Key)}</strong>${aside?`<button type="button" class="sp-icon-btn" data-aside-open aria-label="${t("incidents")}">${icon("bell")}</button>`:""}</div>
${body}<p class="foot app-foot">Space Ops · ${esc(data?.local.machine??"")} · ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p></main>${aside?asidePanel(aside,open):""}</div></div>`;
  if(!aside)document.body.classList.remove("sp-open-aside");
  if(!document.body.classList.contains("sp-open-nav")&&!document.body.classList.contains("sp-open-aside"))document.body.classList.remove("sp-sheet-open");
  [".sp-side-scroll",".sp-aside-body"].forEach((s,i)=>{const el=root.querySelector(s);if(el)el.scrollTop=scrolls[i]!;});
  bind();
}
function pageSub(){return t(page==="overview"?"subtitle":page==="room"?"roomSub":page==="checks"?"checksSub":page==="inspections"?"inspectionsSub":page==="incidents"?"incidentsSub":page==="reports"?"reportsSub":"settingsSub");}
function side(active:number){
  const machines=data?[{name:data.local.machine,local:true,ok:localFresh()},...data.peers.map(p=>({name:p.name,local:false,ok:p.status==="healthy"}))]:[];
  const late=inspections().filter(i=>i.state==="late").length,total=checks().length;
  const counts:Record<string,number>={checks:total,incidents:active,inspections:late};
  const mode=document.documentElement.dataset.mode??"system",live=localFresh();
  const item=(attrs:string,label:string,trail="")=>`<li><button type="button" class="sp-nitem" ${attrs}><span class="ni-label">${label}</span>${trail}</button></li>`;
  return `<nav class="sp-tile sp-side" aria-label="Space Ops">
<div class="sp-brand"><img class="brand-logo" src="/icon.png" alt=""><div class="sp-brand-txt"><strong>Space Ops</strong><span class="sp-brand-sub"><span class="live"><span class="sp-dot ${live?"ok":offline?"bad":"warn"}"></span>${t(live?"live":"disconnected")}</span></span></div><button type="button" class="sp-icon-btn sp-side-close" data-drawer-close aria-label="${t("closeNav")}">${icon("close")}</button></div>
<div class="sp-search" role="search">${icon("search")}<input id="q" type="search" value="${esc(query)}" placeholder="${t("search")}" aria-label="${t("search")}" autocomplete="off"><span class="sp-kbd" aria-hidden="true">/</span></div>
<div class="sp-side-scroll">
<div class="sp-ngroup"><div class="sp-nlabel" id="g-machines">${t("machines")}</div><ul aria-labelledby="g-machines">${item(`data-machine="all" aria-pressed="${machine==="all"}"`,t("allMachines"))}${machines.map(m=>item(`data-machine="${esc(m.name)}" aria-pressed="${machine===m.name}"`,`${esc(m.name)}${m.local?` <span class="sp-nc">${t("local")}</span>`:""}`,m.ok?"":`<span class="sp-nc stale-word"><span class="sp-dot warn"></span>${t("staleShort")}</span>`)).join("")}</ul></div>
<div class="sp-ngroup"><div class="sp-nlabel" id="g-views">${t("navView")}</div><ul aria-labelledby="g-views">${PAGES.map(p=>item(`data-page="${p}" ${page===p?'aria-current="page"':""}`,t(p),counts[p]?`<span class="sp-nc">${counts[p]}</span>`:"")).join("")}</ul></div>
</div>
<div class="sp-side-foot"><div class="sp-seg sm" role="group" aria-label="${t("language")}"><button type="button" data-lang="zh" lang="zh" aria-pressed="${lang==="zh"}">中</button><button type="button" data-lang="en" lang="en" aria-pressed="${lang==="en"}">EN</button></div>
<button type="button" class="sp-icon-btn" id="theme-cycle" title="${esc(t("themeCycle").replace("{m}",t(mode as Key)))}" aria-label="${esc(t("themeCycle").replace("{m}",t(mode as Key)))}">${icon(mode==="light"?"sun":mode==="dark"?"moon":"auto")}</button></div>
</nav>`;
}
function banner(){return `<div class="sp-banner warn" role="alert">${icon("warn")}<span class="grow">${t("loadFailed")}</span></div>`;}
/** The main action of every view: run checks now (the screen's one ink button), then the quiet ones. */
function actions(aside=false){const busy=!!data?.busy;return `${aside?`<button type="button" class="sp-btn sp-only-mid" data-aside-open>${icon("bell")}<span>${t("incidents")}</span></button>`:""}${diagnoseButton("sp-btn")}<button type="button" class="sp-btn" id="new">${icon("plus")}<span>${t("newCheck")}</span></button><button type="button" class="sp-btn-ink" id="scan" ${busy?"disabled":""}>${icon("refresh",busy?"spin":"")}<span>${t(busy?"scanning":"scan")}</span></button>`;}
function head(title:string,sub:string,acts=actions()){return `<header class="sp-head"><div class="head-title"><h1>${esc(title)}</h1><p class="sp-head-sub">${esc(sub)}</p></div>${acts?`<div class="sp-head-actions">${acts}</div>`:""}</header>`;}
function tileHead(title:string,extra=""){return `<div class="tile-h"><h2 class="sp-tt"><span class="sp-sq" aria-hidden="true"></span>${title}</h2>${extra}</div>`;}
const viewAll=(view:string)=>`<button type="button" class="sp-btn ghost sm" data-goto="${view}">${t("viewAll")}${icon("chevron")}</button>`;
/** A heading on the canvas that opens a level of the overview: a title and one muted line. */
function sectionHead(title:string,sub:string){return `<div class="sec-head"><h2>${esc(title)}</h2><p>${esc(sub)}</p></div>`;}
function empty(text:string,ico="check",sub=""){return `<div class="sp-state small-state"><span class="ico">${icon(ico)}</span><p>${esc(text)}</p>${sub?`<p>${esc(sub)}</p>`:""}</div>`;}

// ---------------------------------------------------------------- overview
/** One check as a row: state word, name and kind, machine, time, optional actions. */
function checkRow(c:Listed,opts:{status?:string;label?:string;time?:string;acts?:string;selected?:boolean}={}){const s=opts.status??shown(c),sel=opts.selected??selectedKey===keyOf(c.id,c.machine);
  return `<li class="sp-row crow" data-check="${esc(c.id)}" data-host="${esc(c.machine)}" ${sel?'aria-selected="true"':""}><span class="c-st">${badge(s,opts.label)}</span><span class="c-main"><button type="button" class="c-name">${esc(c.name)}<span class="kind">${esc(kindWord(c.kind))}</span></button><small>${esc(c.app)} · ${esc(c.detail||t(c.coverage))}</small></span><span class="c-mach">${chip(c.machine)}</span><span class="c-time">${opts.time??ago(c.observedAt)}</span>${opts.acts!==undefined?`<span class="c-act">${opts.acts}</span>`:""}</li>`;}
function rows(items:string[],emptyText:string,ico="check"){return items.length?`<ul class="sp-rows">${items.join("")}</ul>`:empty(emptyText,ico);}
function overview(){
  const cs=checks(),is=incidents(),count=(s:Shown)=>cs.filter(c=>shown(c)===s).length;
  const attention=cs.filter(c=>matches(c,"attention")),oneOff=cs.filter(c=>shown(c)==="transient"),unknown=cs.filter(c=>shown(c)==="unknown"),clean=cleared(cs,is);
  const open=is.filter(i=>i.status!=="resolved");
  const things=attention.length+open.filter(i=>!attention.some(c=>c.id===i.checkId&&c.machine===i.machine)).length;
  const [headline,dot]=things?[things===1?t("heroOne"):tn("heroCount",things),"bad"]:unknown.length||!cs.length?[t("heroUnknown"),""]:oneOff.length?[t("heroOneOff"),"warn"]:[t("heroGood"),"ok"];
  const snapshots=[{name:data!.local.machine,snapshot:data!.local as Snapshot|null,status:localFresh()?"healthy":"unknown",local:true},...data!.peers.map(p=>({...p,local:false}))].filter(p=>machine==="all"||p.name===machine);
  const history=snapshots.length===1?snapshots[0]?.snapshot?.history??[]:data!.local.history,historyHost=snapshots.length===1?snapshots[0]!.name:data!.local.machine;
  // The counts the left column already shows (checks, incidents, inspection) are not repeated here.
  const stats:[Key,number,string][]=[["healthy",count("healthy"),"checks:healthy"],["transient",oneOff.length,"checks:transient"],["unknownChecks",unknown.length,"checks:unknown"]];
  const inAside=pickAside(open),incidentOf=(c:Listed)=>open.find(i=>i.checkId===c.id&&i.machine===c.machine);
  const attentionActs=(c:Listed)=>{const i=incidentOf(c);if(!i)return "";return `${i.status==="open"&&!i.remote?`<button type="button" class="sp-btn sm" data-ack="${esc(i.id)}">${t("ack")}</button>`:""}<button type="button" class="sp-btn ghost sm" data-aside="${esc(keyOf(i.id,i.machine))}">${t("viewIncident")}</button>`;};
  const signals=[{k:"oneoff",label:t("oneOffTitle"),n:oneOff.length+clean.length,more:oneOff.length>6?viewAll("checks:transient"):"",body:`${rows([...oneOff.slice(0,6).map(c=>checkRow(c,{time:ago(c.failedAt??c.observedAt)})),...clean.slice(0,4).map(c=>checkRow(c,{status:"cleared",label:t("selfCleared"),time:ago(c.failedAt)}))],t("oneOffEmpty"))}<p class="foot">${t("oneOffSub")}</p>`},
    ...(unknown.length?[{k:"unknown",label:t("unknownChecks"),n:unknown.length,more:unknown.length>5?viewAll("checks:unknown"):"",body:`${rows(unknown.slice(0,5).map(c=>checkRow(c)),"")}<p class="foot">${t("unknownSub")}</p>`}]:[])];
  // The tab chosen by hand while it exists; else the first one with something in it.
  const sig=signals.find(x=>x.k===signalTab)??signals.find(x=>x.n)??signals[0]!;
  return `${head(t("overview"),scanLine(),actions(!!inAside))}
${offline?banner():""}
<section class="sp-tile hero"><div class="hero-top"><h2 class="verdict">${dot?`<span class="sp-dot ${dot}" aria-hidden="true"></span>`:`<span class="sp-dot none" aria-hidden="true"></span>`}${esc(headline)}</h2>
<div class="head-stats">${stats.map(([k,n,go])=>`<button type="button" class="hs" data-goto="${go}"><span class="sp-unit">${t(k)}</span><b>${n}</b></button>`).join("")}</div></div>
<div class="hero-chart">${tileHead(t("recentActivity"))}<div class="scan-history">${history.length?history.map(h=>{const total=Math.max(1,h.passing+h.failing+h.unknown+(h.transient??0));return `<button type="button" data-scan="${esc(h.at)}" data-host="${esc(historyHost)}" title="${esc(date(h.at))} · ${h.passing}/${total}" aria-label="${t("scanAt")} ${esc(date(h.at))}" class="scan-bar ${h.failing?"fail":h.transient?"oneoff":h.unknown?"unknown":""}" style="--h:${Math.max(10,100*h.passing/total)}%"></button>`;}).join(""):`<p class="sp-hint">${t("noHistory")}</p>`}</div>
<div class="history-axis"><span>${history[0]?ago(history[0].at):"—"}</span><span class="scan-legend"><span><span class="sp-dot ok"></span>${t("scanOk")}</span><span><span class="sp-dot warn"></span>${t("scanOneOff")}</span><span><span class="sp-dot bad"></span>${t("scanFail")}</span><span><span class="sp-dot none"></span>${t("scanUnknown")}</span></span><span>${t("historyHint")}</span></div></section>
<section class="sp-tile pad">${tileHead(t("attention"),attention.length>6?viewAll("checks:attention"):"")}${rows(attention.slice(0,6).map(c=>checkRow(c,{time:ago(c.failedAt??c.observedAt),acts:attentionActs(c),selected:!!incidentOf(c)&&incidentOf(c)===inAside})),t("attentionEmpty"),"shield")}</section>
${sectionHead(t("watching"),t("watchingSub"))}
<section class="sp-tile pad"><div class="tabs-h"><div class="tabs" role="tablist" aria-label="${t("watching")}">${signals.map(x=>`<button type="button" role="tab" aria-selected="${x===sig}" data-signal="${x.k}">${x.label}<span class="n">${x.n}</span></button>`).join("")}</div>${sig.more}</div><div role="tabpanel">${sig.body}</div></section>
${sectionHead(t("machines"),t("machinesSub"))}
${resourcesTile(snapshots)}
<div class="sp-banner coverage">${icon("shield")}<div class="grow"><strong>${t("coverageTitle")}</strong><p>${t("coverageDesc")}</p></div><button type="button" class="sp-btn sm" id="coverage-new">${icon("plus")}${t("newCheck")}</button></div>`;
}
/** Bytes in GB (or MB under one GB), one decimal. */
function bytes(n:number){return n>=1e9?`${(n/1e9).toFixed(1)} GB`:`${Math.round(n/1e6)} MB`;}
function meter(percent:number|undefined,threshold:number,fresh:boolean,detail:string){
  if(percent===undefined)return `<span class="mcell none"><span class="sp-meter"><i></i></span><span class="pct">—</span></span><small>${esc(detail)}</small>`;
  const cls=!fresh?"stale":percent>=threshold?"bad":percent>=threshold-15?"warn":"";
  return `<span class="mcell"><span class="sp-meter ${cls}" style="--v:${Math.max(0,Math.min(100,percent))}%"><i></i></span><span class="pct">${percent}%</span></span><small>${esc(detail)}</small>`;
}
/** Measured CPU, memory, disk and load of every machine in view; grey when its snapshot is stale. A number not measured says so. Each row selects its machine. */
function resourcesTile(snapshots:{name:string;snapshot:Snapshot|null;status:string;local:boolean}[]){
  const s=data!.settings;
  const tr=(m:typeof snapshots[number])=>{const r:HostResources|undefined=m.snapshot?.resources,fresh=m.status==="healthy",all=m.snapshot?.checks??[],ok=all.filter(c=>c.status==="healthy").length;
    const name=`<td class="r-name"><button type="button" class="m-name">${esc(m.name)}</button> <span class="sp-nc">${m.local?t("local"):t("peer")}</span>${fresh?"":` <span class="sp-badge warn">${t("staleShort")}</span>`}<small>${fresh?(r?`${t("sampled")} ${ago(r.sampledAt)}`:""):esc(t("stale"))}</small></td>`;
    const checksCell=`<td class="r-checks"><span class="cl">${t("checksCol")}</span>${fresh?`<span class="frac">${ok}<span class="sp-unit"> / ${all.length}</span></span><small>${t("healthyRatio")}</small>`:`<span class="frac muted">—</span>`}</td>`;
    if(!r)return `<tr data-machine="${esc(m.name)}" class="${fresh?"":"stale"}" ${machine===m.name?'aria-selected="true"':""}>${name}${checksCell}<td colspan="4" class="r-none">${t("resourcesEmpty")}</td></tr>`;
    const load=r.load?`<span class="pct">${r.load.one}</span><small>${r.load.five} · ${r.load.fifteen}</small>`:`<span class="pct">—</span>`;
    return `<tr data-machine="${esc(m.name)}" class="${fresh?"":"stale"}" ${machine===m.name?'aria-selected="true"':""}>${name}${checksCell}
<td class="r-m"><span class="cl">${t("cpuUsage")}</span>${meter(r.cpu?.percent,s.cpuPercent,fresh,r.cpu?`${r.cpu.cores} ${t("cores")}`:t("unknown"))}</td>
<td class="r-m"><span class="cl">${t("memoryUsage")}</span>${meter(r.memory?.percent,s.memoryPercent,fresh,r.memory?`${bytes(r.memory.usedBytes)} / ${bytes(r.memory.totalBytes)}`:t("unknown"))}</td>
<td class="r-m"><span class="cl">${t("diskUsage")}</span>${meter(r.disk?.percent,s.diskPercent,fresh,r.disk?`${bytes(r.disk.usedBytes)} / ${bytes(r.disk.totalBytes)}`:t("unknown"))}</td>
<td class="r-load num"><span class="cl">${t("loadShort")}</span>${load}</td></tr>`;};
  return `<section class="sp-tile pad res-tile">${tileHead(t("hostResources"))}<table class="sp-table rt"><thead><tr><th scope="col">${t("machine")}</th><th scope="col">${t("checksCol")}</th><th scope="col">${t("cpuUsage")}</th><th scope="col">${t("memoryUsage")}</th><th scope="col">${t("diskUsage")}</th><th scope="col" class="num">${t("loadShort")}</th></tr></thead><tbody>${snapshots.map(tr).join("")}</tbody></table><p class="foot">${t("resourcesHint")}</p></section>`;
}
/** The overview's right column: the chosen open incident, else the newest (critical first). */
function pickAside(open:ListedIncident[]){if(!open.length)return undefined;return open.find(i=>keyOf(i.id,i.machine)===asideKey)??open.slice().sort((a,b)=>(a.severity==="critical"?0:1)-(b.severity==="critical"?0:1)||b.openedAt.localeCompare(a.openedAt))[0];}
function asidePanel(i:ListedIncident,open:ListedIncident[]){
  const [n,unit]=lasted(i.openedAt),others=open.filter(o=>o!==i);
  return `<aside class="sp-tile sp-aside" id="aside" aria-labelledby="aside-title">
<div class="sp-aside-head"><h2 class="sp-tt" id="aside-title"><span class="sp-sq" aria-hidden="true"></span>${t("incidents")}</h2><div class="aside-btns"><button type="button" class="sp-btn ghost sm" data-incident="${esc(i.id)}" data-host="${esc(i.machine)}">${t("openDetail")}</button><button type="button" class="sp-icon-btn sp-aside-close" data-drawer-close aria-label="${t("closeIncident")}">${icon("close")}</button></div></div>
<div class="sp-aside-body" data-incident-panel="${esc(keyOf(i.id,i.machine))}">
<div class="inc-name"><strong>${esc(i.name)}</strong>${chip(i.machine)}</div>
<div class="inc-badges">${badge(i.status)}${sevBadge(i.severity)}${i.source==="manual"?chip(t("manualIncident")):""}</div>
<div class="sp-stat dur"><span class="sp-fig lg">${n}</span><span class="sp-unit">${esc(unit)} · ${t("lasting")}</span></div>
<p class="inc-detail">${esc(i.detail)}</p>
${timeline(i)}
${i.remote?`<p class="foot">${t("readOnly")}</p>`:incidentForm(i,true)}
${others.length?`<div class="others"><h3 class="sec-h">${t("otherOpen")}</h3><ul class="sp-rows">${others.map(o=>`<li class="sp-row orow" data-aside="${esc(keyOf(o.id,o.machine))}"><span class="c-main"><button type="button" class="c-name">${esc(o.name)}</button><small>${esc(o.machine)} · ${t("since")} ${ago(o.openedAt)}</small></span>${badge(o.status)}</li>`).join("")}</ul></div>`:""}
</div></aside>`;
}

// ---------------------------------------------------------------- views
/** Every machine as a cabinet; a peer whose snapshot is stale goes dark. */
function roomPage(){
  const local:RackMachine={name:data!.local.machine,local:true,fresh:localFresh(),checks:data!.local.checks,openIncidents:data!.local.incidents.filter(i=>i.status!=="resolved").length,resources:data!.local.resources};
  const peers=data!.peers.map((p):RackMachine=>({name:p.name,local:false,fresh:p.status==="healthy"&&!!p.snapshot,checks:p.snapshot?.checks??[],openIncidents:(p.snapshot?.incidents??[]).filter(i=>i.status!=="resolved").length,resources:p.snapshot?.resources}));
  return `${head(t("room"),t("roomSub"))}${offline?banner():""}${roomScene([local,...peers],data!.settings,machine)}`;
}
function seg(options:{v:string;label:string;n?:number}[],current:string,attr="data-filter"){return `<div class="sp-seg filters" role="group">${options.map(o=>`<button type="button" ${attr}="${o.v}" aria-pressed="${current===o.v}">${esc(o.label)}${o.n?` <span class="n">${o.n}</span>`:""}</button>`).join("")}</div>`;}
function checksPage(){
  const cs=checks(),filtered=cs.filter(c=>matches(c,filter)&&`${c.name} ${c.app} ${c.machine}`.toLowerCase().includes(query.toLowerCase()));
  const order:Record<string,number>={failing:0,recovering:1,transient:2,unknown:3,running:4,paused:5,off:5,healthy:6};
  filtered.sort((a,b)=>(order[shown(a)]??9)-(order[shown(b)]??9)||a.name.localeCompare(b.name));
  const tr=(c:Listed)=>{const s=shown(c);return `<tr data-check="${esc(c.id)}" data-host="${esc(c.machine)}" ${selectedKey===keyOf(c.id,c.machine)?'aria-selected="true"':""}><td class="t-st">${badge(s)}</td><td class="t-name"><button type="button" class="c-name">${esc(c.name)}</button><small>${esc(kindWord(c.kind))} · ${t(c.coverage)}</small></td><td class="t-mach">${chip(c.machine)}</td><td class="t-app">${esc(c.app)}</td><td class="t-time num">${s==="transient"?ago(c.failedAt??c.observedAt):ago(c.observedAt)}</td></tr>`;};
  return `${head(t("checks"),t("checksSub"))}${offline?banner():""}
<div class="sp-toolbar">${seg(["all","attention","transient","unknown","paused"].map(f=>({v:f,label:t(f as Key),n:f==="all"?0:cs.filter(c=>matches(c,f)).length})),filter)}${query?`<button type="button" class="sp-btn ghost sm" id="clear-q">${icon("close")}“${esc(query)}”</button>`:""}</div>
<section class="sp-tile list-tile">${filtered.length?`<table class="sp-table ct"><thead><tr><th scope="col">${t("status")}</th><th scope="col">${t("check")}</th><th scope="col">${t("machine")}</th><th scope="col">${t("app")}</th><th scope="col" class="num">${t("observed")}</th></tr></thead><tbody>${filtered.map(tr).join("")}</tbody></table>`:empty(t("noMatch"),"search")}
<div class="list-foot"><span>${filtered.length} / ${cs.length} ${t("count")}</span><button type="button" class="sp-btn ghost sm" id="export">${icon("download")}${t("export")}</button></div></section>
<p class="foot">${t("notVerified")}</p>`;
}
type ListedInspection=Inspection&{machine:string};
/** Every machine's declared app checks; a peer's readings go unknown with its snapshot. */
function inspections():ListedInspection[]{if(!data)return[];return [...(data.local.inspections??[]).map(i=>({...i,machine:data!.local.machine,...(!localFresh()?{state:"unknown" as const,detail:t("stale")}:{})})),...data.peers.flatMap(p=>(p.snapshot?.inspections??[]).map(i=>({...i,machine:p.name,...(p.status==="unknown"?{state:"unknown" as const,detail:p.error??t("stale")}:{})})))].filter(i=>machine==="all"||i.machine===machine);}
const inspText=(i:Inspection)=>({title:i.i18n?.[lang]?.title??i.title??i.name,app:i.i18n?.[lang]?.appTitle??i.appTitle,description:i.i18n?.[lang]?.description??i.description});
function inspectionPage(){
  const all=inspections(),order:Record<string,number>={late:0,unknown:1,pending:2,done:3,off:4};
  const list=all.filter(i=>filter==="all"||i.state===filter).filter(i=>{const x=inspText(i);return `${x.title} ${x.app} ${i.machine}`.toLowerCase().includes(inspQuery.toLowerCase());}).sort((a,b)=>(order[a.state]??9)-(order[b.state]??9)||inspText(a).app.localeCompare(inspText(b).app)||inspText(a).title.localeCompare(inspText(b).title));
  const rowOf=(i:ListedInspection)=>{const x=inspText(i),due=i.due?`${t("dueAt").replace("{t}",i.due)}${i.timezone?` (${i.timezone})`:""}`:t("noDue");
    return `<li class="sp-row irow" title="${esc(i.detail)}"><span class="c-st">${badge(i.state,t(`st_${i.state}` as Key))}</span><span class="c-main"><strong>${esc(x.title)}</strong>${x.description?`<p>${esc(x.description)}</p>`:""}<small>${esc(x.app)} · ${esc(due)}${i.state!=="done"&&i.doneAt?` · ${t("lastDone")} ${ago(i.doneAt)}`:""}</small>${i.state==="unknown"?`<small>${esc(i.detail)}</small>`:""}</span><span class="c-mach">${chip(i.machine)}</span><span class="c-time">${ago(i.observedAt)}</span></li>`;};
  return `${head(t("inspections"),t("inspectionsSub"))}${offline?banner():""}
<div class="sp-toolbar">${seg(["all","late","pending","done","off","unknown"].map(f=>({v:f,label:t(f==="all"?"all":`st_${f}` as Key),n:f==="all"?0:all.filter(i=>i.state===f).length})),filter)}<div class="sp-search tb-search">${icon("search")}<input id="insp-q" type="search" value="${esc(inspQuery)}" placeholder="${t("searchInspections")}" aria-label="${t("searchInspections")}" autocomplete="off"></div></div>
<section class="sp-tile list-tile">${all.length?rows(list.map(rowOf),t("noMatch"),"search"):empty(t("inspectionsEmpty"),"clipboard",t("inspectionsHow"))}</section><p class="foot">${t("inspectionsNote")}</p>`;
}
function incidentRow(i:ListedIncident){return `<li class="sp-row irow click" data-incident="${esc(i.id)}" data-host="${esc(i.machine)}" ${selectedKey===keyOf(i.id,i.machine)?'aria-selected="true"':""}><span class="c-st">${badge(i.status)}</span><span class="c-main"><button type="button" class="c-name">${esc(i.name)}${i.source==="manual"?`<span class="kind">${t("manualIncident")}</span>`:""}</button><p>${esc(i.detail)}</p><small>${esc(i.app)} · ${t(i.severity)} · ${t("since")} ${ago(i.openedAt)}${i.resolvedAt?` · ${t("recovered")} ${ago(i.resolvedAt)}`:""}</small></span><span class="c-mach">${chip(i.machine)}</span><span class="c-time">${ago(i.openedAt)}</span></li>`;}
function incidentPage(){
  const all=incidents(),is=all.filter(i=>filter==="all"||filter==="attention"&&i.status!=="resolved"||i.status===filter);
  return `${head(t("incidents"),t("incidentsSub"))}${offline?banner():""}
<div class="sp-toolbar">${seg(["all","attention","resolved"].map(f=>({v:f,label:t(f as Key)})),filter)}<span class="tb-gap"></span><button type="button" class="sp-btn" id="new-incident">${icon("plus")}${t("newIncident")}</button></div>
<section class="sp-tile list-tile">${is.length?`<ul class="sp-rows">${is.map(incidentRow).join("")}</ul>`:empty(t("emptyIncidents"),"shield",t("attentionNote"))}</section>`;
}
/** The one-click diagnosis: disabled while one runs, so a second click cannot start a second run. */
function diagnoseButton(cls:string){const run=diagnosing(),ready=!!data?.diagnosisReady;return `<button type="button" class="${cls}" data-diagnose ${run||!ready?"disabled":""} title="${ready?`${t("diagnoseScope")} ${machine==="all"?t("allMachines"):machine}`:t("diagnoseUnavailable")}">${icon(run?"refresh":"spark",run?"spin":"")}<span>${t(run?"diagnosing":"diagnose")}</span></button>`;}
function reportBadge(r:ReportItem){return r.status==="done"?badge(r.verdict==="ok"?"healthy":r.verdict==="issues"?"failing":"unknown",t(`vd_${r.verdict??"incomplete"}` as Key)):badge(r.status,t(`rp_${r.status}` as Key));}
function reportsPage(){
  const all=data!.reports??[];
  return `${head(t("reports"),t("reportsSub"))}${offline?banner():""}
<div class="sp-banner">${icon("spark")}<div class="grow"><strong>${t("diagnoseTitle")}</strong><p>${t(data!.diagnosisReady?"diagnoseHint":"diagnoseUnavailable")}</p></div></div>
<section class="sp-tile pad">${tileHead(t("reportHistory"))}${all.length?`<ul class="sp-rows">${all.map(r=>`<li class="sp-row irow click" data-report="${esc(r.id)}"><span class="c-st">${reportBadge(r)}</span><span class="c-main"><button type="button" class="c-name">${esc(r.status==="running"?t("diagnosing"):r.status==="failed"?t("rp_failed"):r.summary||t("vd_"+(r.verdict??"incomplete") as Key))}</button>${r.status==="failed"&&r.error?`<p>${esc(r.error)}</p>`:""}<small>${esc(date(r.startedAt))} · ${t("reportTarget")} ${esc((r.machines??[r.machine]).join(", "))}</small></span><span class="c-time">${ago(r.startedAt)}</span></li>`).join("")}</ul>`:empty(t("reportsEmpty"),"doc",t("reportsHow"))}</section><p class="foot">${t("reportsNote")}</p>`;
}
const covTone:Record<string,string>={done:"healthy",partial:"transient",skipped:"unknown",failed:"failing"};
async function showReport(id:string){
  openReport=id;let r:Report;
  try{r=(await request(`/api/reports/${encodeURIComponent(id)}`)).report;}catch(e){toast((e as Error).message,true);return;}
  const multi=(r.machines?.length??1)>1;
  const duration=r.finishedAt?Math.round((Date.parse(r.finishedAt)-Date.parse(r.startedAt))/1000):null;
  const facts:[string,string][]=[[t("reportStarted"),date(r.startedAt)],[t("reportFinished"),r.finishedAt?`${date(r.finishedAt)}${duration!==null?` · ${duration<60?`${duration}${t("seconds")}`:`${Math.round(duration/60)}${t("minutes")}`}`:""}`:"—"],[t("reportTarget"),(r.machines??[r.machine]).join(", ")],...(r.targets.some(x=>x.includes("/"))?[[t("reportApps"),r.targets.filter(x=>x.includes("/")).join(", ")] as [string,string]]:[]),...(r.call?.model?[[t("reportModel"),`${r.call.runtime?`${r.call.runtime} · `:""}${r.call.model}`] as [string,string]]:[]),...(r.by?[[t("reportBy"),r.by] as [string,string]]:[])];
  modal(`${dialogHead(r.status==="done"?r.summary||t("reportTitle"):t(r.status==="running"?"diagnosing":"rp_failed"),`${r.machine} · ${date(r.startedAt)}`)}<div class="sp-dialog-body"><div class="status-line">${reportBadge(r)}</div>
${r.status==="failed"?`<div class="sp-banner bad">${icon("warn")}<div class="grow"><strong>${t("reportError")}</strong><p>${esc(r.error??t("error"))}</p></div></div>`:""}${r.status==="running"?`<div class="sp-banner">${icon("info")}<span class="grow">${t("runningHint")}</span></div>`:""}
${factList(facts)}
${r.coverage.length?`<h3 class="sec-h">${t("reportScope")}</h3><ul class="sp-rows boxed">${r.coverage.map(c=>`<li class="sp-row"><span class="c-main"><strong>${multi&&c.machine?`${esc(c.machine)} · `:""}${esc(t(("cov_"+c.name.replace(/\W+/g,"_")) as Key)??c.name)}</strong><small>${esc(c.detail)}</small></span>${badge(covTone[c.status]??"unknown",t(`cs_${c.status}` as Key))}</li>`).join("")}</ul>`:""}
${r.body?`<h3 class="sec-h">${t("reportTitle")}</h3><article class="report-body">${markdown(r.body)}</article>`:""}
${r.status==="failed"?`<div class="dlg-actions"><button type="button" class="sp-btn" data-diagnose ${diagnosing()||!data?.diagnosisReady?"disabled":""}>${icon("refresh")}${t("retry")}</button></div>`:""}</div>`,true);
  overlay.querySelector("dialog")?.addEventListener("close",()=>{openReport=null;});
  overlay.querySelector<HTMLElement>("[data-diagnose]")?.addEventListener("click",()=>void diagnose());
}
async function diagnose(){
  try{const d=await request("/api/reports","POST",{lang,machine});toast(t("diagnoseStarted"));await load();if(overlay.querySelector("dialog[open]"))void showReport(d.report.id);}
  catch(e){toast((e as Error).message||t("error"),true);await load();}
}
function stepper(name:keyof Settings,value:number,min:number,max:number){return `<span class="stepper"><button type="button" class="sp-icon-btn" data-step="-1" aria-label="−">−</button><input class="sp-input" type="number" name="${name}" min="${min}" max="${max}" value="${value}" required aria-label="${t(name as Key)}"><button type="button" class="sp-icon-btn" data-step="1" aria-label="+">+</button></span>`;}
function settingsPage(){
  const s=data!.settings,mode=document.documentElement.dataset.mode??"system",choices=SCAN_CHOICES.includes(s.scanMinutes)?SCAN_CHOICES:[...SCAN_CHOICES,s.scanMinutes].sort((a,b)=>a-b);
  const setRow=(label:string,control:string,sub="",tag="div")=>`<${tag} class="sp-row set-row"><span class="c-main"><span class="set-l">${label}</span>${sub?`<small>${sub}</small>`:""}</span>${control}</${tag}>`;
  // Saving is this view's main action, so it carries the ink button instead of Run checks.
  return `${head(t("settings"),t("settingsSub"),"")}${offline?banner():""}<form id="settings-form" class="settings">
<section class="sp-tile pad">${tileHead(t("scanGroup"))}<ul class="sp-rows">${setRow(t("scanMinutes"),`<select class="sp-select auto" name="scanMinutes" aria-label="${t("scanMinutes")}">${choices.map(n=>`<option value="${n}" ${s.scanMinutes===n?"selected":""}>${tn(n===1?"minuteN":"minutesN",n)}</option>`).join("")}</select>`,"","li")}${setRow(t("nextScan"),`<span class="value">${data!.scan?.nextAt?esc(until(data!.scan.nextAt)):"—"}</span>`,"","li")}</ul><p class="foot">${t("scanHint")}</p></section>
<section class="sp-tile pad">${tileHead(t("detection"))}<ul class="sp-rows">${([["failAfter",1,20],["recoverAfter",1,20],["taskErrorThreshold",1,20],["diskPercent",50,99],["memoryPercent",50,99],["cpuPercent",50,99]] as const).map(([k,min,max])=>setRow(t(k),stepper(k,s[k],min,max),"","li")).join("")}</ul><p class="foot">${t("detectionHint")}</p></section>
<section class="sp-tile pad">${tileHead(t("notifications"))}<ul class="sp-rows">${setRow(t("notifyDesc"),`<label class="sp-switch"><span class="sp-sr">${t("notifications")}</span><input type="checkbox" name="notifications" ${s.notifications?"checked":""} ${!data!.notificationReady?"disabled":""}><span class="sp-track"></span></label>`,t(data!.notificationReady?"notificationHint":"notifyUnavailable"),"li")}${setRow(`${t("notifyPending")} / ${t("notifyFailed")}`,`<span class="value">${data!.notificationQueue.pending} / ${data!.notificationQueue.failed??0}</span>`,"","li")}</ul></section>
<section class="sp-tile pad">${tileHead(t("appearance"))}<ul class="sp-rows">${setRow(t("theme"),`<span class="sp-seg sm in-tile" role="group" aria-label="${t("theme")}">${["system","light","dark"].map(v=>`<button type="button" data-theme-choice="${v}" aria-pressed="${mode===v}">${t(v as Key)}</button>`).join("")}</span>`,"","li")}${setRow(t("language"),`<select class="sp-select auto" id="locale" aria-label="${t("language")}"><option value="zh" ${lang==="zh"?"selected":""}>简体中文</option><option value="en" ${lang==="en"?"selected":""}>English</option></select>`,"","li")}</ul><p class="foot">${t("retention")}</p></section>
<div class="form-actions"><button class="sp-btn-ink" type="submit">${t("saveSettings")}</button></div></form>`;
}

// ---------------------------------------------------------------- dialogs
function modal(content:string,drawer=false){overlay.innerHTML=`<dialog class="sp-dialog ops-dlg ${drawer?"inspector":"sheet"}">${content}</dialog>`;const d=overlay.querySelector("dialog")!;d.showModal();d.addEventListener("click",e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});d.addEventListener("close",()=>{overlay.innerHTML="";render();});overlay.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",()=>d.close()));}
function dialogHead(title:string,subtitle:string){return `<header class="sp-dialog-head"><div class="dh"><h2 class="sp-tt"><span class="sp-sq" aria-hidden="true"></span><span>${esc(title)}</span></h2>${subtitle?`<p class="sp-hint">${esc(subtitle)}</p>`:""}</div><button type="button" class="sp-icon-btn" data-close aria-label="${t("close")}">${icon("close")}</button></header>`;}
const factList=(facts:[string,unknown][])=>`<dl class="sp-facts">${facts.map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;
const field=(label:string,input:string,hint="")=>`<label class="sp-field"><span class="lbl">${label}</span>${input}${hint?`<small class="sp-hint">${hint}</small>`:""}</label>`;
function newRule(rule?:Rule){
  modal(`${dialogHead(rule?t("edit"):t("newCheck"),t("checkLocal"))}<form id="rule-form" class="dlg-form"><div class="sp-dialog-body">
${field(t("template"),`<select id="template" class="sp-select"><option value="endpoint">${t("endpoint")}</option><option value="freshness">${t("freshness")}</option><option value="verified">${t("verified")}</option></select>`)}${field(t("name"),`<input class="sp-input" name="name" required maxlength="120" value="${esc(rule?.name??"")}" placeholder="API availability">`)}${field(t("url"),`<input class="sp-input mono" name="url" type="url" required value="${esc(rule?.url??"")}" placeholder="http://127.0.0.1:8700/healthz">`)}${field(t("app"),`<input class="sp-input" name="app" value="${esc(rule?.app??"custom")}">`)}
<div class="f-grid">${field(t("expectedStatus"),`<input class="sp-input" name="expectedStatus" type="number" min="200" max="599" required value="${rule?.expectedStatus??200}">`)}${field(t("severity"),`<select class="sp-select" name="severity"><option value="warning">${t("warning")}</option><option value="critical" ${rule?.severity==="critical"?"selected":""}>${t("critical")}</option></select>`)}${field(t("interval"),`<input class="sp-input" name="interval" type="number" min="15" max="86400" required value="${(rule?.intervalMs??300000)/1000}">`,t("intervalHint"))}${field(t("timeout"),`<input class="sp-input" name="timeout" type="number" min="1" max="30" required value="${(rule?.timeoutMs??5000)/1000}">`)}${field(t("failAfter"),`<input class="sp-input" name="failAfter" type="number" min="1" max="20" required value="${rule?.failAfter??3}">`)}${field(t("recoverAfter"),`<input class="sp-input" name="recoverAfter" type="number" min="1" max="20" required value="${rule?.recoverAfter??2}">`)}</div>
${field(t("assertions"),`<textarea class="sp-textarea mono" name="assertions" rows="4" spellcheck="false">${esc(JSON.stringify(rule?.assertions??[],null,2))}</textarea>`,t("assertionsHint"))}<div class="f-grid">${field(t("timezone"),`<input class="sp-input" name="timezone" value="${esc(rule?.timezone??"")}" placeholder="${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}">`,t("timezoneHint"))}${field(t("weekdays"),`<input class="sp-input" name="weekdays" value="${esc(rule?.weekdays?.join(",")??"")}" placeholder="0,1,2,3,4,5,6">`,t("weekdaysHint"))}</div>${field(t("recoveryTime"),`<input class="sp-input mono" name="evidenceTimestampPath" value="${esc(rule?.evidenceTimestampPath??"")}" placeholder="$.latest.finishedAt">`,t("resultTimeHint"))}${field(t("recoveryTask"),`<input class="sp-input mono" name="recoveryTaskId" value="${esc(rule?.recoveryTaskId??"")}">`,t("recoveryHint"))}
<p class="sp-err form-error" role="alert"></p></div><div class="sp-dialog-foot"><span class="sp-hint foot-hint">${t("ruleHint")}</span><button type="button" class="sp-btn" data-close>${t("cancel")}</button><button class="sp-btn-ink" type="submit">${t("save")}</button></div></form>`);
  overlay.querySelector<HTMLSelectElement>("#template")!.onchange=e=>{const v=(e.target as HTMLSelectElement).value;overlay.querySelector<HTMLTextAreaElement>("textarea")!.value=JSON.stringify(v==="freshness"?[{path:"$.lastVerifiedSuccessAt",operator:"ageLessThan",value:93600000}]:v==="verified"?[{path:"$.output.verified",operator:"eq",value:true}]:[],null,2);};
  overlay.querySelector<HTMLFormElement>("form")!.onsubmit=async e=>{e.preventDefault();const form=e.currentTarget as HTMLFormElement,fd=new FormData(form),submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=true;try{await request(rule?`/api/rules/${encodeURIComponent(rule.id)}`:"/api/rules",rule?"PUT":"POST",{weekdays:String(fd.get("weekdays")??"").trim()?String(fd.get("weekdays")).split(",").map(v=>v.trim()?Number(v):NaN):undefined,timezone:fd.get("timezone"),recoveryTaskId:fd.get("recoveryTaskId"),evidenceTimestampPath:fd.get("evidenceTimestampPath"),name:fd.get("name"),url:fd.get("url"),app:fd.get("app"),expectedStatus:Number(fd.get("expectedStatus")),intervalMs:Number(fd.get("interval"))*1000,timeoutMs:Number(fd.get("timeout"))*1000,failAfter:Number(fd.get("failAfter")),recoverAfter:Number(fd.get("recoverAfter")),severity:fd.get("severity"),assertions:JSON.parse(String(fd.get("assertions")))});overlay.querySelector("dialog")!.close();toast(t("saved"));await load();}catch(err){form.querySelector(".form-error")!.textContent=String((err as Error).message);}finally{submit.disabled=false;}};
}
async function showCheck(id:string,host:string){const c=checks().find(c=>c.id===id&&c.machine===host);if(!c)return;
  selectedKey=keyOf(id,host);
  const rule=!c.remote?data!.rules.find(r=>r.id===id):undefined,s=shown(c),muted=!!c.mutedUntil&&Date.parse(c.mutedUntil)>Date.now(),openIncident=incidents().find(i=>i.checkId===id&&i.machine===host&&i.status!=="resolved");
  const facts:[string,unknown][]=([["observed",date(c.observedAt)],["lastPass",date(c.lastPassedAt)],...(c.failedAt?[["failedAt",date(c.failedAt)] as [Key,unknown]]:[]),["evidenceTime",date(c.evidenceAt)],["value",c.value??"—"],["threshold",c.threshold??"—"],["failures",c.failures],["successes",c.successes]] as [Key,unknown][]).map(([k,v])=>[t(k),v]);
  modal(`${dialogHead(c.name,`${host} · ${c.app}`)}<div class="sp-dialog-body"><div class="status-line">${badge(s)}<span class="sp-hint">${esc(kindWord(c.kind))} · ${t(c.coverage)}${muted?` · ${t("muted")}`:""}</span></div>${s==="transient"?`<div class="sp-banner warn">${icon("info")}<span class="grow">${t("transientHint")}</span></div>`:""}
<h3 class="sec-h">${t("evidence")}</h3><div class="evidence"><code class="sp-code">${esc(c.code)}</code><p>${esc(c.detail)}</p></div>${factList(facts)}
<h3 class="sec-h">${t("history")}</h3><div class="probe-history" id="probe-history"><span class="sp-hint">${t("noHistory")}</span></div><p class="foot">${t(c.remote?"readOnly":rule?"ruleHint":"automaticHint")}</p>${c.kind==="task"&&!c.remote?policyForm(id.slice(5)):""}${c.remote?"":`<div class="dlg-actions"><button type="button" class="sp-btn" id="toggle-check">${t(c.enabled?"pause":"resume")}</button><button type="button" class="sp-btn" id="mute-check">${t(muted?"unmute":"mute")}</button>${openIncident?`<button type="button" class="sp-btn" id="view-incident">${t("viewIncident")}</button>`:`<button type="button" class="sp-btn" id="new-incident-check">${t("createIncident")}</button>`}${rule?`<button type="button" class="sp-btn" id="edit-rule">${t("edit")}</button>`:""}</div>`}</div>`,true);
  overlay.querySelector("#view-incident")?.addEventListener("click",()=>showIncident(openIncident!.id,host));
  overlay.querySelector("#new-incident-check")?.addEventListener("click",()=>newIncident(c));
  overlay.querySelector("#toggle-check")?.addEventListener("click",()=>act(async()=>{await request(`/api/checks/${encodeURIComponent(id)}`,"PATCH",{enabled:!c.enabled});overlay.querySelector("dialog")?.close();await load();}));
  overlay.querySelector("#mute-check")?.addEventListener("click",()=>act(async()=>{await request(`/api/checks/${encodeURIComponent(id)}`,"PATCH",{muteMinutes:muted?0:60});toast(t("saved"));overlay.querySelector("dialog")?.close();await load();}));
  overlay.querySelector("#edit-rule")?.addEventListener("click",()=>newRule(rule));
  overlay.querySelector<HTMLFormElement>("#policy-form")?.addEventListener("submit",e=>{e.preventDefault();void act(async()=>{const fd=new FormData(e.target as HTMLFormElement),num=(k:string)=>fd.get(k)?Number(fd.get(k)):null;await request(`/api/task-policies/${encodeURIComponent(id.slice(5))}`,"PUT",{deadlineMinutes:num("deadlineMinutes"),errorThreshold:num("errorThreshold")});toast(t("saved"));overlay.querySelector("dialog")?.close();await load();});});
  if(!c.remote){try{const r=await request(`/api/checks/${encodeURIComponent(id)}`);const el=overlay.querySelector("#probe-history");if(el&&r.history.length)el.innerHTML=r.history.slice().reverse().map((h:{at:string;verdict:string;code:string})=>`<span class="probe ${esc(h.verdict)}" title="${esc(date(h.at))} · ${esc(h.verdict)} · ${esc(h.code)}"></span>`).join("")+`<span class="probe-key"><span><span class="sp-dot ok"></span>${t("pass")}</span><span><span class="sp-dot bad"></span>${t("fail")}</span></span>`;}catch{/* Detail remains usable while a refresh is unavailable. */}}
}
function policyForm(taskId:string){const p=data!.taskPolicies?.[taskId]??{};return `<form id="policy-form" class="policy"><h3 class="sec-h">${t("taskPolicy")}</h3><div class="f-grid">${field(t("deadlineMinutes"),`<input class="sp-input" type="number" name="deadlineMinutes" min="1" max="1440" value="${p.deadlineMinutes??""}" placeholder="${t("off")}">`)}${field(t("errorThresholdLocal"),`<input class="sp-input" type="number" name="errorThreshold" min="1" max="20" value="${p.errorThreshold??""}" placeholder="${data!.settings.taskErrorThreshold}">`)}</div><p class="foot">${t("policyHint")}</p><div class="dlg-actions"><button class="sp-btn" type="submit">${t("savePolicy")}</button></div></form>`;}
/** Event dots: a fault opening is red, a recovery green, everything else neutral; the event's word sits beside it. */
const evTone:Record<string,string>={opened:"bad",created:"bad",resolved:"ok",recovered:"ok"};
const who=(by?:string)=>by==="operator"?t("operator"):by;
function timeline(i:Incident){return `<h3 class="sec-h">${t("timeline")}</h3><ol class="timeline">${i.events.slice().reverse().map(e=>`<li class="${e.type==="note"?"record":""}"><span class="tl-time">${esc(date(e.at))}${e.by?` · ${esc(who(e.by))}`:""}</span><span class="sp-dot ${evTone[e.type]??"none"}" aria-hidden="true"></span><strong>${esc(t(("ev_"+e.type) as Key)??e.type)}</strong>${e.detail?`<p>${esc(e.detail)}</p>`:""}</li>`).join("")}</ol>`;}
/** The repair record and the incident's actions; `compact` is the overview's right column. */
function incidentForm(i:ListedIncident,compact=false){const open=i.status!=="resolved",key=keyOf(i.id,i.machine);
  return `<form class="inc-form" data-key="${esc(key)}"><h3 class="sec-h">${t("repairLog")}</h3><label class="sp-sr" for="note-${esc(i.id)}${compact?"-a":""}">${t("repairLog")}</label><textarea class="sp-textarea" id="note-${esc(i.id)}${compact?"-a":""}" name="text" rows="3" maxlength="2000" placeholder="${t("notePlaceholder")}">${esc(drafts.get(key)??"")}</textarea>${open&&!compact?`<p class="foot">${t("resolveHint")}</p>`:""}
<div class="dlg-actions"><button type="submit" class="sp-btn" data-action="notes">${t("addNote")}</button>${i.status==="open"?`<button type="button" class="sp-btn" data-ack-form>${t("ack")}</button>`:""}${compact?diagnoseButton("sp-btn"):""}${open?`<button type="submit" class="sp-btn resolve" data-action="resolve">${icon("check")}${t("markResolved")}</button>`:""}</div></form>`;}
function bindIncidentForm(scope:ParentNode,i:ListedIncident,after:()=>Promise<void>){
  const form=scope.querySelector<HTMLFormElement>(".inc-form");if(!form)return;const key=keyOf(i.id,i.machine);
  form.querySelector("textarea")?.addEventListener("input",e=>drafts.set(key,(e.target as HTMLTextAreaElement).value));
  form.querySelector("[data-ack-form]")?.addEventListener("click",()=>act(async()=>{await request(`/api/incidents/${encodeURIComponent(i.id)}/ack`,"POST",{});await after();}));
  form.querySelector("[data-diagnose]")?.addEventListener("click",e=>{(e.currentTarget as HTMLElement).setAttribute("disabled","");void diagnose();});
  form.addEventListener("submit",e=>{e.preventDefault();const action=((e as SubmitEvent).submitter as HTMLElement|null)?.dataset.action??"notes",text=String(new FormData(form).get("text")??"").trim();
    if(action==="notes"&&!text){form.querySelector<HTMLTextAreaElement>("textarea")?.focus();return;}
    void act(async()=>{await request(`/api/incidents/${encodeURIComponent(i.id)}/${action}`,"POST",{text});drafts.delete(key);toast(t(action==="resolve"?"resolvedToast":"noted"));await after();});});
}
function showIncident(id:string,host:string){const i=incidents().find(i=>i.id===id&&i.machine===host);if(!i)return;
  selectedKey=keyOf(id,host);
  const open=i.status!=="resolved",resolvedBy=i.resolvedBy==="check"?t("resolvedByCheck"):who(i.resolvedBy);
  const facts:[string,string][]=[[t("since"),date(i.openedAt)],[t("updated"),date(i.updatedAt)],...(i.resolvedAt?[[t("resolved"),`${date(i.resolvedAt)}${resolvedBy?` · ${resolvedBy}`:""}`] as [string,string]]:[])];
  const check=checks().find(c=>c.id===i.checkId&&c.machine===host);
  modal(`${dialogHead(i.name,`${host} · ${i.app}`)}<div class="sp-dialog-body"><div class="status-line"><span class="inc-badges">${badge(i.status)}${sevBadge(i.severity)}${i.source==="manual"?chip(t("manualIncident")):""}</span></div>${i.source==="manual"&&open?`<div class="sp-banner">${icon("info")}<span class="grow">${t("manualHint")}</span></div>`:""}
<h3 class="sec-h">${t("evidence")}</h3><div class="evidence"><p>${esc(i.detail)}</p></div>${check?`<ul class="sp-rows boxed"><li class="sp-row orow" data-open-check><span class="c-main"><button type="button" class="c-name">${esc(check.name)}</button><small>${t("incidentFor")}</small></span>${badge(shown(check))}${icon("chevron","chev")}</li></ul>`:""}${factList(facts)}
${i.remote?"":incidentForm(i)}${timeline(i)}${i.remote?`<p class="foot">${t("readOnly")}</p>`:""}</div>`,true);
  overlay.querySelector("[data-open-check]")?.addEventListener("click",()=>void showCheck(check!.id,host));
  bindIncidentForm(overlay,i,async()=>{await load();showIncident(id,host);});
}
function newIncident(check?:Listed){
  modal(`${dialogHead(check?t("createIncident"):t("newIncident"),check?`${check.machine} · ${check.app}`:t("checkLocal"))}<form id="incident-new" class="dlg-form"><div class="sp-dialog-body">${check?factList([[t("incidentFor"),check.name]]):`${field(t("incidentName"),`<input class="sp-input" name="name" required maxlength="120">`)}${field(t("app"),`<input class="sp-input" name="app" maxlength="80" value="custom">`)}`}${field(t("severity"),`<select class="sp-select" name="severity"><option value="warning" ${check?.severity!=="critical"?"selected":""}>${t("warning")}</option><option value="critical" ${check?.severity==="critical"?"selected":""}>${t("critical")}</option></select>`)}${field(t("incidentDetail"),`<textarea class="sp-textarea" name="detail" rows="4" maxlength="2000" ${check?"":"required"}>${esc(check?.detail??"")}</textarea>`,t("incidentDetailHint"))}<p class="sp-err form-error" role="alert"></p></div><div class="sp-dialog-foot"><button type="button" class="sp-btn" data-close>${t("cancel")}</button><button class="sp-btn-ink" type="submit">${t("createIncident")}</button></div></form>`);
  overlay.querySelector<HTMLFormElement>("#incident-new")!.onsubmit=async e=>{e.preventDefault();const form=e.currentTarget as HTMLFormElement,fd=new FormData(form),submit=form.querySelector<HTMLButtonElement>('[type="submit"]')!;submit.disabled=true;
    try{const r=await request("/api/incidents","POST",{...(check?{checkId:check.id}:{name:fd.get("name"),app:fd.get("app")}),severity:fd.get("severity"),detail:fd.get("detail")});toast(t("incidentCreated"));await load();showIncident(r.incident.id,data!.local.machine);}catch(err){form.querySelector(".form-error")!.textContent=String((err as Error).message);}finally{submit.disabled=false;}};
}
async function showScan(at:string,host:string){
  const when=Date.parse(at),local=host===data!.local.machine;
  const open=incidents().filter(i=>i.machine===host&&Date.parse(i.openedAt)<=when&&(!i.resolvedAt||Date.parse(i.resolvedAt)>=when));
  modal(`${dialogHead(t("scanRecords"),`${host} · ${t("scanAt")} ${date(at)}`)}<div class="sp-dialog-body"><h3 class="sec-h">${t("activeThen")}</h3>${open.length?`<ul class="sp-rows boxed">${open.map(incidentRow).join("")}</ul>`:empty(t("noIncidentsThen"))}<h3 class="sec-h">${t("failedThen")}</h3><div id="scan-checks">${local?`<span class="sp-sk"></span>`:`<p class="foot">${t("peerScanHint")}</p>`}</div></div>`,true);
  overlay.querySelectorAll<HTMLElement>("[data-incident]").forEach(el=>el.onclick=()=>showIncident(el.dataset.incident!,el.dataset.host!));
  if(!local)return;
  const box=overlay.querySelector("#scan-checks");
  try{const r:{record:ScanRecord}=await request(`/api/scans/${encodeURIComponent(at)}`);if(!box)return;
    box.innerHTML=r.record.checks.length?`<ul class="sp-rows boxed">${r.record.checks.map(c=>{const live=checks().find(x=>x.id===c.id&&x.machine===host);return `<li class="sp-row orow ${live?"click":""}" ${live?`data-check="${esc(c.id)}" data-host="${esc(host)}"`:""}><span class="c-main">${live?`<button type="button" class="c-name">${esc(c.name)}</button>`:`<strong>${esc(c.name)}</strong>`}<small>${esc(c.app)} · <code>${esc(c.code)}</code> · ${esc(date(c.at))}</small></span>${badge(c.status==="pending"?"transient":c.status)}</li>`;}).join("")}</ul>`:empty(t("noFailuresThen"));
    box.querySelectorAll<HTMLElement>("[data-check]").forEach(el=>el.onclick=()=>void showCheck(el.dataset.check!,el.dataset.host!));
  }catch(e){if(box)box.innerHTML=`<p class="foot">${esc((e as Error).message)}</p>`;}
}
async function act(fn:()=>Promise<void>){try{await fn();}catch(e){toast((e as Error).message||t("error"),true);}}

// ---------------------------------------------------------------- wiring
function setTheme(mode:string){const d=document.documentElement;d.dataset.mode=mode;try{if(mode==="system")localStorage.removeItem("ops-theme");else localStorage.setItem("ops-theme",mode);}catch{/* the choice lasts for this page only */}if(mode==="light"||mode==="dark")d.dataset.theme=mode;else delete d.dataset.theme;themeColor();}
function themeColor(){const m=document.documentElement.dataset.mode,dark=m==="dark"||(m!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);document.querySelector('meta[name="theme-color"]')?.setAttribute("content",dark?"#121212":"#f3f3f3");}
function bind(){
  bindRoom(root,name=>{machine=name;navigate("overview");});
  const click=(sel:string,fn:(el:HTMLElement,e:MouseEvent)=>void)=>root.querySelectorAll<HTMLElement>(sel).forEach(el=>el.addEventListener("click",e=>fn(el,e)));
  click("[data-page]",el=>navigate(el.dataset.page!));
  click("[data-goto]",el=>{const [p,f]=el.dataset.goto!.split(":");navigate(p!,f);});
  click("[data-machine]",el=>{machine=machine===el.dataset.machine&&el.tagName==="TR"?"all":el.dataset.machine!;closeDrawers();render();});
  click("[data-signal]",el=>{signalTab=el.dataset.signal!;try{localStorage.setItem("ops-signal-tab",signalTab);}catch{/* private window */}render();});
  click("[data-filter]",el=>{filter=el.dataset.filter!;render();});
  click("[data-check]",el=>void showCheck(el.dataset.check!,el.dataset.host!));
  click("[data-incident]",(el,e)=>{e.stopPropagation();showIncident(el.dataset.incident!,el.dataset.host!);});
  click("[data-scan]",el=>void showScan(el.dataset.scan!,el.dataset.host!));
  click("[data-report]",el=>void showReport(el.dataset.report!));
  click("[data-diagnose]",el=>{if(el.closest(".inc-form"))return;el.setAttribute("disabled","");void diagnose();});
  click("[data-aside]",(el,e)=>{e.stopPropagation();asideKey=el.dataset.aside!;render();if(!matchMedia("(min-width: 1200px)").matches)openDrawer("sp-open-aside");});
  click("[data-ack]",(el,e)=>{e.stopPropagation();void act(async()=>{await request(`/api/incidents/${encodeURIComponent(el.dataset.ack!)}/ack`,"POST",{});await load();});});
  click("[data-nav-open]",()=>{openDrawer("sp-open-nav");});
  click("[data-aside-open]",()=>openDrawer("sp-open-aside"));
  click("[data-drawer-close]",()=>closeDrawers());
  click("[data-lang]",el=>{setLang(el.dataset.lang!);render();});
  click("#theme-cycle",()=>{const m=document.documentElement.dataset.mode??"system";setTheme(m==="system"?"light":m==="light"?"dark":"system");render();});
  root.querySelector("#new-incident")?.addEventListener("click",()=>newIncident());
  root.querySelector("#new")?.addEventListener("click",()=>newRule());root.querySelector("#coverage-new")?.addEventListener("click",()=>newRule());
  root.querySelector("#scan")?.addEventListener("click",()=>act(async()=>{await request("/api/scan","POST",{});toast(t("scanStarted"));await load();}));
  // The sidebar search filters the check list; typing anywhere else takes you there.
  root.querySelector<HTMLInputElement>("#q")?.addEventListener("input",e=>{const el=e.target as HTMLInputElement,pos=el.selectionStart;query=el.value;if(page!=="checks"){page="checks";location.hash="checks";filter="all";}render();const input=root.querySelector<HTMLInputElement>("#q")!;input.focus();input.setSelectionRange(pos,pos);});
  root.querySelector("#clear-q")?.addEventListener("click",()=>{query="";render();});
  root.querySelector<HTMLInputElement>("#insp-q")?.addEventListener("input",e=>{const el=e.target as HTMLInputElement,pos=el.selectionStart;inspQuery=el.value;render();const input=root.querySelector<HTMLInputElement>("#insp-q")!;input.focus();input.setSelectionRange(pos,pos);});
  root.querySelector("#export")?.addEventListener("click",()=>{const blob=new Blob([JSON.stringify(data!.rules,null,2)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download="space-ops-rules.json";a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  click("[data-step]",el=>{const input=el.parentElement!.querySelector("input")!;if(el.dataset.step==="1")input.stepUp();else input.stepDown();});
  click("[data-theme-choice]",el=>{setTheme(el.dataset.themeChoice!);root.querySelectorAll("[data-theme-choice]").forEach(b=>b.setAttribute("aria-pressed",String(b===el)));});
  root.querySelector<HTMLSelectElement>("#locale")?.addEventListener("change",e=>{setLang((e.target as HTMLSelectElement).value);render();});
  root.querySelector<HTMLFormElement>("#settings-form")?.addEventListener("submit",e=>{e.preventDefault();void act(async()=>{const fd=new FormData(e.target as HTMLFormElement),notifications=fd.has("notifications");if(notifications&&!data!.settings.notifications&&!confirm(t("confirmNotify")))return;const body:Record<string,unknown>={notifications};for(const k of ["scanMinutes","failAfter","recoverAfter","taskErrorThreshold","diskPercent","memoryPercent","cpuPercent"])body[k]=Number(fd.get(k));await request("/api/settings","PUT",body);toast(t("saved"));await load();});});
  const panel=root.querySelector<HTMLElement>("[data-incident-panel]");
  if(panel){const i=incidents().find(x=>keyOf(x.id,x.machine)===panel.dataset.incidentPanel);if(i)bindIncidentForm(panel,i,load);}
}
themeColor();matchMedia("(prefers-color-scheme: dark)").addEventListener("change",themeColor);
window.addEventListener("hashchange",()=>{const p=location.hash.slice(1)||"overview";if(p!==page){page=p;filter="all";render();}});
render();void load();setInterval(()=>void load(),15000);
