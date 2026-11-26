import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listEntries, renderListing, renderMarkdownHtml, renderMarkdownPage } from "./render";
import { resolveInput, resolveRequest, respond } from "./serve";

const tmp = mkdtempSync(join(tmpdir(), "serv-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fixtureDir(name: string): string {
  const dir = join(tmp, `${n++}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("markdown", () => {
  test("renders GFM tables, task lists and autolinks with GitHub heading slugs", () => {
    const html = renderMarkdownPage({
      markdown: [
        "## Severity notes",
        "",
        "| Feature | Verdict |",
        "|---|---|",
        "| Picker | Ready |",
        "",
        "- [x] done",
        "",
        "see https://example.com",
      ].join("\n"),
      rootLabel: "reports",
      rel: "README.md",
    });

    // Reports link to #severity-notes, so the id has to match GitHub's slug.
    expect(html).toContain('id="severity-notes"');
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  test("heading ids match GitHub's slugger: separator runs kept, duplicates suffixed", () => {
    const html = renderMarkdownHtml(
      "# B1 — Blocker: early arrival\n\n## B1 — Blocker: early arrival\n\n## Repeat\n\n## Repeat\n",
    );
    // GitHub keeps both hyphens; Bun's own slugger collapses them.
    expect(html).toContain('id="b1--blocker-early-arrival"');
    expect(html).toContain('href="#b1--blocker-early-arrival"');
    expect(html).toContain('id="b1--blocker-early-arrival-1"');
    expect(html).toContain('id="repeat"');
    expect(html).toContain('id="repeat-1"');
  });

  test("?raw returns the source instead of a page", async () => {
    const dir = fixtureDir("raw");
    writeFileSync(join(dir, "note.md"), "## Severity notes\n");
    const res = await respond(dir, "http://localhost/note.md?raw");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("## Severity notes\n");
  });
});

describe("directory listing", () => {
  test("directories first, then files by name, dotfiles hidden, names escaped", () => {
    const dir = fixtureDir("listing");
    mkdirSync(join(dir, "zdir"));
    mkdirSync(join(dir, "adir"));
    writeFileSync(join(dir, "b.txt"), "b");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, ".DS_Store"), "x");
    writeFileSync(join(dir, "<unsafe>.txt"), "x");

    const html = renderListing({ rootLabel: "root", rel: "", entries: listEntries(dir) });
    const at = (s: string) => html.indexOf(s);

    expect(at('href="adir/"')).toBeGreaterThan(-1);
    expect(at('href="adir/"')).toBeLessThan(at('href="zdir/"'));
    expect(at('href="zdir/"')).toBeLessThan(at('href="a.txt"'));
    expect(at('href="a.txt"')).toBeLessThan(at('href="b.txt"'));
    expect(html).not.toContain(".DS_Store");
    expect(html).toContain("&lt;unsafe&gt;.txt");
  });

  test("index.html wins over a listing; README.md is rendered below it", async () => {
    const dir = fixtureDir("readme");
    writeFileSync(join(dir, "README.md"), "## Severity notes\n");

    const withReadme = await (await respond(dir, "http://localhost/")).text();
    expect(withReadme).toContain('<table class="listing">');
    expect(withReadme).toContain('id="severity-notes"');

    writeFileSync(join(dir, "index.html"), "<h1>custom index</h1>");
    const withIndex = await (await respond(dir, "http://localhost/")).text();
    expect(withIndex).toContain("custom index");
    expect(withIndex).not.toContain('<table class="listing">');
  });
});

describe("content types", () => {
  test("source files display as text; images keep their binary type", async () => {
    const dir = fixtureDir("types");
    writeFileSync(join(dir, "index.ts"), "const x = 1\n");
    // 1x1 transparent PNG.
    writeFileSync(
      join(dir, "pixel.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    );

    const ts = await respond(dir, "http://localhost/index.ts");
    expect(ts.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await ts.text()).toContain("const x = 1");

    const png = await respond(dir, "http://localhost/pixel.png");
    expect(png.headers.get("content-type")).toBe("image/png");
  });
});

describe("path resolution", () => {
  test("traversal is rejected, including encoded ..", () => {
    const root = fixtureDir("trav");
    writeFileSync(join(root, "ok.txt"), "ok");

    for (const path of ["/../secret.txt", "/%2e%2e/secret.txt", "/%2E%2E%2Fsecret.txt", "/a/../../secret.txt"]) {
      expect(resolveRequest(root, path)).toEqual({ kind: "outside" });
    }
    expect(resolveRequest(root, "/ok.txt")).toEqual({
      kind: "file",
      path: join(root, "ok.txt"),
      rel: "ok.txt",
    });
  });

  test("a raw request cannot reach a real file outside the root", async () => {
    const base = fixtureDir("trav-http");
    const root = join(base, "root");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET");
    writeFileSync(join(root, "inside.txt"), "inside");

    // %2f keeps the escape in one segment, so it reaches resolveRequest undecoded.
    const outside = await respond(root, "http://localhost/%2e%2e%2fsecret.txt");
    expect(outside.status).toBe(403);
    expect(await outside.text()).not.toContain("TOP-SECRET");
  });

  test("a missing file gets a friendly 404 showing the path and a way back", async () => {
    const dir = fixtureDir("notfound");
    const res = await respond(dir, "http://localhost/nope.md");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("<code>/nope.md</code>");
    expect(body).toContain("parent listing");
  });

  test("single-file mode serves the parent so relative assets resolve", async () => {
    const dir = fixtureDir("single");
    const file = join(dir, "entity-picker.md");
    writeFileSync(file, "![shot](entity-picker/01.png)\n");
    writeFileSync(join(dir, "entity-picker.png"), "not used");

    const input = resolveInput(file);
    expect(input).toEqual({ kind: "file", root: dir, startPath: "/entity-picker.md" });

    const page = await (await respond(input.root, "http://localhost" + input.startPath)).text();
    expect(page).toContain('<img src="entity-picker/01.png"');
    expect(page).toContain('href="/entity-picker.md?raw"');
  });
});
