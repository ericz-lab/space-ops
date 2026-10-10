import { expect, test } from "bun:test";

// Execute each page's loader to catch missing secondary-page integration.
const pages = ["web/index.html"];
for (const page of pages) {
  test(`Space usage heartbeat: ${page}`, async () => {
    const html = await Bun.file(new URL("./" + page, import.meta.url)).text();
    const loaders = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1]!).filter((script) => script.includes("/_space/usage.js"));
    expect(loaders).toHaveLength(1);
    const scripts: { src?: string; defer?: boolean }[] = [];
    new Function("document", loaders[0]!)({
      createElement: (tag: string) => { expect(tag).toBe("script"); return {}; },
      head: { appendChild: (script: { src?: string; defer?: boolean }) => scripts.push(script) },
    });
    expect(scripts).toEqual([{ src: "/_space/usage.js", defer: true }]);
  });
}
