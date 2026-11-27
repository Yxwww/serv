import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HIGHLIGHT_LIMIT, HIGHLIGHT_LINE_LIMIT } from "./highlight";
import { respond } from "./serve";

const root = mkdtempSync(join(tmpdir(), "serv-highlight-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function fixtureDir(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("syntax highlighting", () => {
  test("code and JSON pages get dual-theme token spans; HTML is escaped", async () => {
    const dir = fixtureDir("tokens");
    writeFileSync(join(dir, "app.ts"), 'const html = "<b>";\n');
    writeFileSync(join(dir, "data.json"), '{"b":2,"a":1}');

    const ts = await (await respond(dir, "http://localhost/app.ts")).text();
    expect(ts).toContain('<div class="source">');
    expect(ts).toContain('<pre class="gutter" aria-hidden="true">1</pre>');
    expect(ts).toContain('<span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">const</span>');
    expect(ts).toContain("&lt;b&gt;");
    expect(ts).not.toContain("<b>");
    // The token colors are theme variables, and the page's CSS switches them.
    expect(ts).toContain("color:var(--shiki-light)");
    expect(ts).toContain("color:var(--shiki-dark)");

    const json = await (await respond(dir, "http://localhost/data.json", { "sec-fetch-dest": "document" })).text();
    expect(json).toContain('<pre class="gutter" aria-hidden="true">1\n2\n3\n4</pre>');
    expect(json).toContain("&quot;b&quot;</span>");
    expect(json).toContain("&quot;a&quot;</span>");
    expect(json).toContain("--shiki-light:#");
    expect(json).toContain("--shiki-dark:#");
  });

  test("oversized files and extensions with no grammar stay plain", async () => {
    const dir = fixtureDir("plain");
    // One line past the byte cap; only two lines, so the line cap cannot be the cause.
    writeFileSync(join(dir, "big.ts"), "const x = 1;\n" + "x".repeat(HIGHLIGHT_LIMIT));
    // Past the line cap, well under the byte cap.
    writeFileSync(join(dir, "many.ts"), "const x = 1;\n".repeat(HIGHLIGHT_LINE_LIMIT + 1));
    writeFileSync(join(dir, "bun.lock"), "lock-marker\n");
    writeFileSync(join(dir, "app.conf"), "conf-marker\n");

    for (const name of ["big.ts", "many.ts"]) {
      const html = await (await respond(dir, `http://localhost/${name}`)).text();
      expect(html).toContain("<code>const x = 1;");
      expect(html).not.toContain('<span style="--shiki-');
    }

    for (const [path, marker] of [
      ["bun.lock", "lock-marker"],
      ["app.conf", "conf-marker"],
    ] as const) {
      const html = await (await respond(dir, `http://localhost/${path}`)).text();
      expect(html).toContain(`<code>${marker}`);
      expect(html).not.toContain('<span style="--shiki-');
    }
  });
});
