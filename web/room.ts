import type { Settings } from "../src/types.ts";
import { t } from "./i18n.ts";
import { rackTone, unitTones, type RackMachine, type Tone } from "./rack.ts";

export type { RackMachine };

const W = 150, H = 280, D = 130, GAP = 90, ROW = 230, COLS = 4, UNITS = 6;
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
/** Camera angles survive the dashboard's re-render every 15 s. */
const view = { rx: -18, ry: -24, manual: false };
let resize: ResizeObserver | undefined;

const level = (p: number | undefined, limit: number) => p === undefined ? "" : p >= limit ? "bad" : p >= limit - 15 ? "warn" : "";
/** Busier CPU blinks faster: 1.6 s idle down to 0.25 s at full load. */
const blink = (cpu?: number) => (1.6 - 1.35 * Math.min(100, Math.max(0, cpu ?? 0)) / 100).toFixed(2);
/** Negative delays keep blinking in phase across re-renders. */
const phase = (period: number, seed: number) => `-${((performance.now() / 1000 + seed * 0.37) % period).toFixed(2)}s`;

function front(m: RackMachine, s: Settings, tone: Tone) {
  const r = m.fresh ? m.resources : undefined, period = Number(blink(r?.cpu?.percent));
  const units = unitTones(m, UNITS).map((u, i) => `<div class="u u-${u}"><span class="u-ear"></span><span class="u-leds">${[0, 1, 2].map(j => `<i style="animation-duration:${(period * (1 + j * .27)).toFixed(2)}s;animation-delay:${phase(period * (1 + j * .27), i * 3 + j)}"></i>`).join("")}</span><span class="u-slots">${"<b></b>".repeat(4)}</span><span class="u-ear"></span></div>`).join("");
  const round = (n?: number) => n === undefined ? undefined : Math.round(n);
  const mem = round(r?.memory?.percent), disk = round(r?.disk?.percent), cpu = round(r?.cpu?.percent);
  const dimms = Array.from({ length: 10 }, (_, i) => `<b class="${mem !== undefined && i < Math.round(mem / 10) ? `on ${level(mem, s.memoryPercent)}` : ""}"></b>`).join("");
  const bays = Array.from({ length: 8 }, (_, i) => `<b class="${disk !== undefined && i < Math.round(disk / 12.5) ? `on ${level(disk, s.diskPercent)}` : ""}"><i></i></b>`).join("");
  const lcd = !m.fresh ? `<span class="lcd-off">${t("roomNoSignal")}</span>`
    : `<span>CPU<em class="${level(cpu, s.cpuPercent)}">${cpu ?? "--"}%</em></span><span>MEM<em class="${level(mem, s.memoryPercent)}">${mem ?? "--"}%</em></span><span>DSK<em class="${level(disk, s.diskPercent)}">${disk ?? "--"}%</em></span>`;
  return `<div class="face front"><div class="plate"><span class="screw"></span><strong>${esc(m.name)}</strong><span class="screw"></span></div>
<div class="bay"><div class="lcd lcd-${tone}">${lcd}</div><div class="units">${units}</div><div class="dimms" title="${t("memoryUsage")}">${dimms}</div><div class="disks" title="${t("diskUsage")}">${bays}</div></div><div class="glass"></div><span class="handle"></span></div>`;
}

function rack(m: RackMachine, s: Settings, x: number, z: number, selected: boolean) {
  const tone = rackTone(m), ok = m.checks.filter(c => c.status === "healthy").length;
  const label = `${m.name} · ${t(`room_${tone}`)}${m.fresh ? ` · ${ok} / ${m.checks.length} ${t("healthyRatio")}` : ""}`;
  return `<div role="button" tabindex="0" class="rack tone-${tone} ${selected ? "selected" : ""}" data-rack="${esc(m.name)}" aria-label="${esc(label)}" title="${esc(label)}" style="transform:translate3d(${x}px,0,${z}px)">
${front(m, s, tone)}<div class="face back"></div><div class="face side left"></div><div class="face side right"></div>
<div class="face top"><span class="fan"></span><span class="fan"></span></div><div class="face shadow"></div><div class="face spill"></div>
<div class="beacon"><span class="lamp"></span><span class="lamp cross"></span></div>
<div class="face tag"><strong>${esc(m.name)}</strong><small>${m.local ? t("local") : t("peer")} · ${esc(t(`room_${tone}`))}</small></div></div>`;
}

export function roomScene(machines: RackMachine[], s: Settings, selected: string) {
  const cols = Math.min(COLS, Math.max(1, machines.length)), rows = Math.ceil(machines.length / COLS) || 1;
  const width = cols * W + (cols - 1) * GAP, depth = rows * D + (rows - 1) * (ROW - D);
  const racks = machines.map((m, i) => {
    const c = i % COLS, r = Math.floor(i / COLS), inRow = Math.min(COLS, machines.length - r * COLS);
    const x = (c - (inRow - 1) / 2) * (W + GAP), z = (r - (rows - 1) / 2) * -ROW;
    return rack(m, s, x, z, selected === m.name);
  }).join("");
  const count = (tone: Tone) => machines.filter(m => rackTone(m) === tone).length;
  return `<section class="room" data-width="${width + 160}" style="--w:${W}px;--h:${H}px;--d:${D}px">
<div class="room-zoom"><div class="orbit ${view.manual ? "manual" : ""}"><div class="stage" style="--rx:${view.rx}deg;--ry:${view.ry}deg">
<div class="floor" style="width:${width + 520}px;height:${depth + 520}px"></div>${racks}</div></div></div>
<div class="room-legend">${(["ok", "warn", "bad", "off"] as Tone[]).map(k => `<span class="legend-${k}"><i></i>${t(`room_${k}`)} <b>${count(k)}</b></span>`).join("")}<span class="room-hint">${t("roomHint")}</span></div></section>
<p class="group-foot">${t("roomNote")}</p>`;
}

/** Drag turns the camera; a click without a drag opens that machine. */
export function bindRoom(root: HTMLElement, open: (name: string) => void) {
  const room = root.querySelector<HTMLElement>(".room"), stage = root.querySelector<HTMLElement>(".stage"), orbit = root.querySelector<HTMLElement>(".orbit");
  if (!room || !stage || !orbit) return;
  const fit = () => { const zoom = Math.min(1, room.clientWidth / Number(room.dataset.width)); room.style.setProperty("--zoom", zoom.toFixed(3)); };
  fit(); resize?.disconnect(); resize = new ResizeObserver(fit); resize.observe(room);
  let start: { x: number; y: number; rx: number; ry: number } | null = null, moved = false;
  room.addEventListener("pointerdown", e => { start = { x: e.clientX, y: e.clientY, rx: view.rx, ry: view.ry }; moved = false; });
  room.addEventListener("pointermove", e => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 5) return;
    if (!moved) { moved = true; room.setPointerCapture(e.pointerId); room.classList.add("dragging"); view.manual = true; orbit.classList.add("manual"); }
    view.ry = start.ry + dx * .35; view.rx = Math.max(-55, Math.min(-4, start.rx - dy * .25));
    stage.style.setProperty("--rx", `${view.rx}deg`); stage.style.setProperty("--ry", `${view.ry}deg`);
  });
  const end = (e: PointerEvent) => {
    if (!start) return; start = null; room.classList.remove("dragging");
    if (moved) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-rack]");
    if (target) open(target.dataset.rack!);
  };
  room.addEventListener("pointerup", end); room.addEventListener("pointercancel", () => { start = null; room.classList.remove("dragging"); });
  root.querySelectorAll<HTMLElement>("[data-rack]").forEach(el => el.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(el.dataset.rack!); } }));
}
