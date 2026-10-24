import { expect, test } from "bun:test";
import type { Check } from "../src/types.ts";
import { rackTone, unitTones, type RackMachine } from "./rack.ts";

const check = (status: string, code = "ok") => ({ id: `${status}-${code}`, name: status, app: "a", kind: "service", verdict: "pass", code, detail: "", coverage: "availability", status, failures: 0, successes: 1, observedAt: "2026-10-25T00:00:00Z", lastPassedAt: null, mutedUntil: null, enabled: true }) as Check;
const machine = (checks: Check[], over: Partial<RackMachine> = {}): RackMachine => ({ name: "m", local: true, fresh: true, checks, openIncidents: 0, ...over });

test("a stale machine is dark, never healthy", () => {
  const m = machine([check("healthy")], { fresh: false });
  expect(rackTone(m)).toBe("off");
  expect(unitTones(m, 3)).toEqual(["off", "off", "off"]);
});

test("failing checks or open incidents light the alarm", () => {
  expect(rackTone(machine([check("healthy"), check("failing")]))).toBe("bad");
  expect(rackTone(machine([check("healthy")], { openIncidents: 1 }))).toBe("bad");
});

test("one-off errors and missing evidence are amber; a running task is not", () => {
  expect(rackTone(machine([check("healthy"), check("transient")]))).toBe("warn");
  expect(rackTone(machine([check("healthy"), check("unknown", "stale_observation")]))).toBe("warn");
  expect(rackTone(machine([check("healthy"), check("unknown", "task_running")]))).toBe("ok");
});

test("paused checks have no light and do not make a machine healthy", () => {
  expect(rackTone(machine([check("paused")]))).toBe("off");
  expect(unitTones(machine([check("healthy"), check("paused")]), 2)).toEqual(["ok", "off"]);
});

test("units carry the checks worst first, in proportion", () => {
  const cs = [...Array(9).fill(0).map(() => check("healthy")), check("failing"), check("failing"), check("transient")];
  expect(unitTones(machine(cs), 6)).toEqual(["bad", "warn", "ok", "ok", "ok", "ok"]);
  expect(unitTones(machine([check("healthy"), check("failing")]), 4)).toEqual(["bad", "bad", "ok", "ok"]);
});
