import { join } from "node:path";

export function inspectionRequest(args: string[], env: Record<string, string | undefined>, port: number): { url: string; headers: Record<string, string>; timeoutMs: number } {
  const [command, id] = args;
  const paths: Record<string, string> = { status: "/api/dashboard", evidence: "/api/evidence", check: `/api/checks/${encodeURIComponent(id ?? "")}` };
  const peer = command === "peer" || command === "peer-evidence";
  if ((!peer && !Object.hasOwn(paths, command ?? "")) || args.length !== (["check", "peer", "peer-evidence"].includes(command ?? "") ? 2 : 1) || id === "") throw new Error("Usage: bun src/inspect.ts status|evidence|check <id>|peer <name>|peer-evidence <name>");
  if (peer) {
    const token = env.SPACE_APP_TOKEN || env.SPACE_API_TOKEN;
    if (!env.SPACE_API_URL || !token) throw new Error("Peer reads require SPACE_API_URL and Space credentials");
    const base = new URL(env.SPACE_API_URL);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid SPACE_API_URL");
    return { url: `${base.href.replace(/\/$/, "")}/api/peers/${encodeURIComponent(id!)}/apps/space-ops/proxy/api/${command === "peer" ? "snapshot" : "evidence"}`, headers: { authorization: `Bearer ${token}` }, timeoutMs: 60_000 };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Space Ops service port");
  return { url: `http://127.0.0.1:${port}${paths[command!]}`, headers: {}, timeoutMs: 60_000 };
}

if (import.meta.main) {
  try {
    const manifest = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "../space.yaml")).text()) as { service: { port: number } };
    const request = inspectionRequest(Bun.argv.slice(2), process.env, manifest.service.port);
    const response = await fetch(request.url, { method: "GET", headers: request.headers, redirect: "error", signal: AbortSignal.timeout(request.timeoutMs), timeout: false });
    if (!response.ok) throw new Error(`Space Ops returned HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Inspection failed");
    process.exitCode = 1;
  }
}
