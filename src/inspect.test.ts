import { expect, test } from "bun:test";
import { inspectionRequest } from "./inspect.ts";

test("local evidence uses the manifest port without forwarding Space credentials", () => {
  const request = inspectionRequest(["evidence"], { SPACE_APP_TOKEN: "secret" }, 8998);
  expect(request.url).toBe("http://127.0.0.1:8998/api/evidence");
  expect(request.headers).toEqual({});
  expect(inspectionRequest(["check", "task/a?b"], {}, 8998).url).toEndWith("/api/checks/task%2Fa%3Fb");
});

test("peer evidence uses the authenticated proxy and encodes peer names", () => {
  const request = inspectionRequest(["peer-evidence", "other/host"], { SPACE_API_URL: "https://space.example/", SPACE_APP_TOKEN: "secret" }, 8998);
  expect(request.url).toBe("https://space.example/api/peers/other%2Fhost/apps/space-ops/proxy/api/evidence");
  expect(request.headers.authorization).toBe("Bearer secret");
});

test("unsupported commands and missing peer configuration fail closed", () => {
  for (const args of [[], ["scan"], ["status", "extra"], ["check"], ["peer", ""]]) expect(() => inspectionRequest(args, {}, 8998)).toThrow();
  expect(() => inspectionRequest(["peer", "other"], {}, 8998)).toThrow("require");
  expect(() => inspectionRequest(["status"], {}, 0)).toThrow("port");
});

test("forget is a same-origin JSON write to this machine's collector, with no Space credential", () => {
  const request = inspectionRequest(["forget", "service:ai-design"], { SPACE_APP_TOKEN: "secret", SPACE_API_URL: "https://space.example/" }, 8998);
  expect(request).toEqual({ url: "http://127.0.0.1:8998/api/checks/service%3Aai-design/forget", method: "POST", headers: { origin: "http://127.0.0.1:8998", "content-type": "application/json" }, body: "{}", timeoutMs: 60_000 });
  expect(inspectionRequest(["status"], {}, 8998).method).toBe("GET");
  for (const args of [["forget"], ["forget", ""], ["forget", "a", "b"]]) expect(() => inspectionRequest(args, {}, 8998)).toThrow("Usage");
});
