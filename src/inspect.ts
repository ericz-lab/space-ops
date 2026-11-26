import { join } from "node:path";

/** Every command reads, except `forget <id>`: the one write, on this machine only, of a check that is no longer observed (POST /api/checks/:id/forget). */
export function inspectionRequest(args: string[], env: Record<string, string | undefined>, port: number): { url: string; method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs: number } {
  const [command, id] = args;
  const paths: Record<string, string> = { status: "/api/dashboard", evidence: "/api/evidence", check: `/api/checks/${encodeURIComponent(id ?? "")}`, forget: `/api/checks/${encodeURIComponent(id ?? "")}/forget` };
  const peer = command === "peer" || command === "peer-evidence";
  if ((!peer && !Object.hasOwn(paths, command ?? "")) || args.length !== (["check", "forget", "peer", "peer-evidence"].includes(command ?? "") ? 2 : 1) || id === "") throw new Error("Usage: bun src/inspect.ts status|evidence|check <id>|forget <id>|peer <name>|peer-evidence <name>");
  if (peer) {
    const token = env.SPACE_APP_TOKEN || env.SPACE_API_TOKEN;
    if (!env.SPACE_API_URL || !token) throw new Error("Peer reads require SPACE_API_URL and Space credentials");
    const base = new URL(env.SPACE_API_URL);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid SPACE_API_URL");
    return { url: `${base.href.replace(/\/$/, "")}/api/peers/${encodeURIComponent(id!)}/apps/space-ops/proxy/api/${command === "peer" ? "snapshot" : "evidence"}`, method: "GET", headers: { authorization: `Bearer ${token}` }, timeoutMs: 60_000 };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Space Ops service port");
  const origin = `http://127.0.0.1:${port}`;
  // A write is a same-origin JSON request, as the page sends it; never any Space credential.
  if (command === "forget") return { url: `${origin}${paths.forget}`, method: "POST", headers: { origin, "content-type": "application/json" }, body: "{}", timeoutMs: 60_000 };
  return { url: `${origin}${paths[command!]}`, method: "GET", headers: {}, timeoutMs: 60_000 };
}

if (import.meta.main) {
  try {
    // The port: the one an installed package was given (<data dir>/service.port, written by its entry; scripts/pack.ts), else the manifest's.
    const manifest = Bun.YAML.parse(await Bun.file(join(import.meta.dir, "../space.yaml")).text()) as { service?: { port: number } };
    const portFile = process.env.SPACE_APP_DATA_DIR ? Bun.file(join(process.env.SPACE_APP_DATA_DIR, "service.port")) : undefined;
    const port = portFile && (await portFile.exists()) ? Number((await portFile.text()).trim()) : manifest.service?.port ?? 8998;
    const request = inspectionRequest(Bun.argv.slice(2), process.env, port);
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, redirect: "error", signal: AbortSignal.timeout(request.timeoutMs), timeout: false });
    if (!response.ok) { const why = await response.json().then(d => (d as { error?: string }).error, () => undefined); throw new Error(`Space Ops returned HTTP ${response.status}${why ? `: ${why}` : ""}`); }
    console.log(JSON.stringify(await response.json(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Inspection failed");
    process.exitCode = 1;
  }
}
