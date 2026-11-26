/**
 * How long this machine's Space has run, as its GET /api/space/uptime answers (ai-space docs/usage.md#uptime):
 * this run's start, every recorded run added up and the restarts, read with the app token each scan and carried in
 * the snapshot, so the hub shows its peers' too. Information only: never a check, an incident or a count. A Space
 * too old to have the route, or one that refuses the app token (401), answers nothing and nothing is shown.
 * `observedAt`: when it was read; past the scan lease the snapshot leaves it out.
 */
export type SpaceUptime = { startedAt: string; currentMs: number; totalMs: number; firstStartedAt: string; restarts: number; observedAt: string };

const instant = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const ms = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
/** The route's answer, or a peer snapshot's field, when it holds what it should; anything else is undefined. */
export function parseUptime(d: unknown, observedAt?: string): SpaceUptime | undefined {
  const u = (d as { uptime?: unknown })?.uptime ?? d, o = u as Partial<SpaceUptime> | null;
  if (!o || typeof o !== "object" || !instant(o.startedAt) || !ms(o.currentMs) || !ms(o.totalMs) || !instant(o.firstStartedAt) || !Number.isInteger(o.restarts) || o.restarts! < 0) return undefined;
  const at = observedAt ?? o.observedAt;
  if (!instant(at)) return undefined;
  return { startedAt: o.startedAt!, currentMs: o.currentMs!, totalMs: o.totalMs!, firstStartedAt: o.firstStartedAt!, restarts: o.restarts!, observedAt: at! };
}

type Lang = "en" | "zh";
const UNIT = { en: { d: " d", h: " h", m: " min" }, zh: { d: " 天", h: " 小时", m: " 分钟" } } as const;
/** Days and hours from a day on, hours and minutes below a day, minutes below an hour. */
export function runSpan(msIn: number, lang: Lang): string {
  const u = UNIT[lang], m = Math.floor(Math.max(0, msIn) / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  const pair = (a: number, ua: string, b: number, ub: string) => b ? `${a}${ua} ${b}${ub}` : `${a}${ua}`;
  return d ? pair(d, u.d, h % 24, u.h) : h ? pair(h, u.h, m % 60, u.m) : `${m}${u.m}`;
}
/** Every run added up, in whole hours (minutes below an hour). */
export function totalSpan(msIn: number, lang: Lang): string {
  const m = Math.floor(Math.max(0, msIn) / 60_000);
  return m < 60 ? `${m}${UNIT[lang].m}` : `${Math.floor(m / 60)}${UNIT[lang].h}`;
}
/**
 * The figures at `now`: a fresh reading goes on counting from when it was read; a stale one (its machine's snapshot
 * expired) stays as it was read, since whether that run still lasts is not known.
 */
export function uptimeAt(u: SpaceUptime, now: number, fresh: boolean): { currentMs: number; totalMs: number; restarts: number } {
  const more = fresh ? Math.max(0, now - Date.parse(u.observedAt)) : 0;
  return { currentMs: u.currentMs + more, totalMs: u.totalMs + more, restarts: u.restarts };
}
/** "已连续运行 3 天 4 小时 · 累计 412 小时 · 重启 5 次" / "Running for 3 d 4 h · 412 h in all · 5 restarts". */
export function uptimeText(u: SpaceUptime, lang: Lang, now = Date.now(), fresh = true): string {
  const a = uptimeAt(u, now, fresh);
  return lang === "zh"
    ? `已连续运行 ${runSpan(a.currentMs, "zh")} · 累计 ${totalSpan(a.totalMs, "zh")} · 重启 ${a.restarts} 次`
    : `Running for ${runSpan(a.currentMs, "en")} · ${totalSpan(a.totalMs, "en")} in all · ${a.restarts} restart${a.restarts === 1 ? "" : "s"}`;
}
