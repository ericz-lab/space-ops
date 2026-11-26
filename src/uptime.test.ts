import { describe, expect, test } from "bun:test";
import { parseUptime, runSpan, totalSpan, uptimeAt, uptimeText } from "./uptime.ts";

const H = 3_600_000, D = 24 * H, read = "2026-11-25T12:00:00.000Z", now = Date.parse(read);
const answer = { ok: true, uptime: { startedAt: "2026-11-22T08:00:00.000Z", currentMs: 3 * D + 4 * H, totalMs: 412 * H + 30 * 60_000, firstStartedAt: "2026-10-01T00:00:00.000Z", restarts: 5 } };

describe("Space uptime", () => {
  test("the route's answer is read as it is; a snapshot's field keeps its own reading time", () => {
    const u = parseUptime(answer, read)!;
    expect(u).toEqual({ ...answer.uptime, observedAt: read });
    expect(parseUptime(u)).toEqual(u);
  });
  test("anything else is nothing: refusals, older answers, broken fields", () => {
    for (const d of [undefined, null, {}, { ok: false, error: "unauthorized" }, { peers: [] }, { uptime: { startedAt: "2026-11-22T08:00:00Z", totalMs: 1 } }, { uptime: { ...answer.uptime, restarts: -1 } }, { uptime: { ...answer.uptime, currentMs: "1" } }, { uptime: { ...answer.uptime, startedAt: "yesterday" } }]) expect(parseUptime(d, read)).toBeUndefined();
    expect(parseUptime(answer.uptime)).toBeUndefined();
  });
  test("spans: days and hours, hours and minutes, minutes; the total in hours", () => {
    expect(runSpan(3 * D + 4 * H + 59_000, "zh")).toBe("3 天 4 小时");
    expect(runSpan(2 * D, "en")).toBe("2 d");
    expect(runSpan(5 * H + 7 * 60_000, "en")).toBe("5 h 7 min");
    expect(runSpan(42 * 60_000, "zh")).toBe("42 分钟");
    expect(runSpan(-5, "en")).toBe("0 min");
    expect(totalSpan(412 * H + 59 * 60_000, "zh")).toBe("412 小时");
    expect(totalSpan(20 * 60_000, "en")).toBe("20 min");
  });
  test("a fresh reading goes on counting; a stale one stays as it was read", () => {
    const u = parseUptime(answer, read)!;
    expect(uptimeText(u, "zh", now)).toBe("已连续运行 3 天 4 小时 · 累计 412 小时 · 重启 5 次");
    expect(uptimeText(u, "en", now)).toBe("Running for 3 d 4 h · 412 h in all · 5 restarts");
    expect(uptimeAt(u, now + 2 * H, true)).toEqual({ currentMs: 3 * D + 6 * H, totalMs: 414 * H + 30 * 60_000, restarts: 5 });
    expect(uptimeText(u, "en", now + 2 * D, false)).toBe("Running for 3 d 4 h · 412 h in all · 5 restarts");
    expect(uptimeText({ ...u, restarts: 1 }, "en", now)).toContain("· 1 restart");
  });
});
