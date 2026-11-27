import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "./cli";
import { scanFiles, tagRows } from "./files";
import { ENTRY_LIMIT, listEntries, renderListing, renderMarkdownHtml, renderMarkdownPage, renderSourcePage } from "./render";
import { resolveInput, resolveRequest, respond, SOURCE_LIMIT } from "./serve";
import { MAX_TREE_ENTRIES, readTreeLevel, readTreeLevels, renderSidebar, renderTreeFragment } from "./tree";

const tmp = mkdtempSync(join(tmpdir(), "serv-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fixtureDir(name: string): string {
  const dir = join(tmp, `${n++}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function initRepo(dir: string): void {
  const run = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, stdout: "ignore", stderr: "ignore" });
  expect(run.exitCode).toBe(0);
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

    const shell = await respond(dir, "http://localhost/note.md");
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(shell.headers.get("vary")).toBe("Sec-Fetch-Dest");
  });

  test("both panels ship in the page; ?view= picks the initial one; source is escaped", async () => {
    const dir = fixtureDir("md-view");
    writeFileSync(join(dir, "note.md"), "# Title\n\n<script>alert(1)</script>\n");

    const auto = await (await respond(dir, "http://localhost/note.md")).text();
    expect(auto).toContain('class="serv-md-page serv-md-rendered"');
    expect(auto).toContain('<div class="md-view" data-md-view>');
    expect(auto).toContain('<div class="md-panel" data-md-panel="rendered"><article class="markdown prose max-w-none">');
    expect(auto).toContain('<div class="md-panel" data-md-panel="source">');
    expect(auto).toContain('class="view-option is-active" data-md-link="rendered" href="?view=rendered" aria-current="true">Preview</a>');
    expect(auto).toContain('class="view-option" data-md-link="source" href="?view=source">Source</a>');
    expect(auto).toContain('localStorage.getItem("serv-md-view")');

    // The source panel holds the Markdown itself, escaped as text.
    const sourcePanel = auto.slice(auto.indexOf('data-md-panel="source"'));
    expect(sourcePanel).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(sourcePanel).not.toContain("<script>alert(1)</script>");

    const source = await (await respond(dir, "http://localhost/note.md?view=source")).text();
    expect(source).toContain('class="serv-md-page serv-md-source"');
    expect(source).toContain('class="view-option is-active" data-md-link="source" href="?view=source" aria-current="true">Source</a>');
    expect(source).toContain('class="view-option" data-md-link="rendered" href="?view=rendered">Preview</a>');

    // An unknown value falls back to the rendered default.
    const invalid = await (await respond(dir, "http://localhost/note.md?view=wat")).text();
    expect(invalid).toContain('class="serv-md-page serv-md-rendered"');
  });

  test("a non-Markdown source page keeps its exact body and gains no toggle", () => {
    const text = "const a = 1;\nif (a < 2) {\n  run();\n}\n";
    const html = renderSourcePage({ text, rootLabel: "root", rel: "app.ts" });
    expect(html).toContain(
      '<div class="source"><pre class="gutter" aria-hidden="true">1\n2\n3\n4</pre><pre class="code"><code>const a = 1;\nif (a &lt; 2) {\n  run();\n}</code></pre></div>',
    );
    // The CSS mentions the panel selectors, so assert the page carries no panel.
    expect(html).not.toContain('class="md-view"');
    expect(html).not.toContain('class="md-panel"');
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain("md-toggle");
  });
});

describe("directory listing", () => {
  test("directories first, then files by name, dotfiles tagged, names escaped", () => {
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
    expect(html).toContain('<tr data-hidden><td class="name">');
    expect(html).toContain(".DS_Store");
    expect(html).toContain("&lt;unsafe&gt;.txt");
  });

  test("index.html wins over a listing; README.md sits beside the files", async () => {
    const dir = fixtureDir("readme");
    writeFileSync(join(dir, "README.md"), "## Severity notes\n");

    const withReadme = await (await respond(dir, "http://localhost/")).text();
    expect(withReadme).toContain('<table class="listing">');
    expect(withReadme).toContain('id="severity-notes"');
    expect(withReadme).toContain('<div class="listing-split"><div class="listing-panels">');
    expect(withReadme).toContain('<section class="readme-panel">');
    expect(withReadme).toContain('<section class="files-panel" data-listing-view');
    expect(withReadme.indexOf('class="readme-panel"')).toBeLessThan(withReadme.indexOf('class="files-panel"'));
    expect(withReadme).toContain('href="/README.md?raw"');
    expect(withReadme).toContain('Files <span class="panel-count">1</span>');
    expect(withReadme).not.toContain('<hr class="split">');

    writeFileSync(join(dir, "index.html"), "<h1>custom index</h1>");
    const withIndex = await (await respond(dir, "http://localhost/")).text();
    expect(withIndex).toContain("custom index");
    expect(withIndex).not.toContain('<table class="listing">');
  });

  test("a folder without a README gives the files panel the full width", async () => {
    const dir = fixtureDir("no-readme");
    writeFileSync(join(dir, "a.txt"), "a");
    const html = await (await respond(dir, "http://localhost/")).text();
    expect(html).toContain('<section class="files-panel files-panel-full" data-listing-view');
    expect(html).not.toContain('class="listing-split"');
    expect(html).not.toContain('class="readme-panel"');
  });

  test("defaults to grid, honors ?view=grid and ?view=list, and links both", async () => {
    const dir = fixtureDir("views");
    writeFileSync(join(dir, "note.txt"), "x");

    const auto = await (await respond(dir, "http://localhost/")).text();
    expect(auto).toContain('data-view="grid"');
    expect(auto).toContain('<div class="listing-view" data-view-panel="list" hidden>');
    expect(auto).toContain('<div class="listing-view" data-view-panel="grid">');
    expect(auto).toContain('class="view-option is-active" data-view-link="grid"');
    expect(auto).toContain('href="?view=list"');
    expect(auto).toContain('href="?view=grid"');
    expect(auto).toContain('localStorage.getItem("serv-view")');

    // The script scopes both the panels and the toggle links to this element.
    const rootStart = auto.indexOf("data-listing-view");
    const rootEnd = auto.indexOf("</section>", rootStart);
    const rootMarkup = auto.slice(rootStart, rootEnd);
    expect(rootMarkup).toContain('data-view-link="list"');
    expect(rootMarkup).toContain('data-view-panel="list"');

    const list = await (await respond(dir, "http://localhost/?view=list")).text();
    expect(list).toContain('data-view="list"');
    expect(list).toContain('<div class="listing-view" data-view-panel="list">');
    expect(list).toContain('<div class="listing-view" data-view-panel="grid" hidden>');
    expect(list).toContain('class="view-option is-active" data-view-link="list"');

    const grid = await (await respond(dir, "http://localhost/?view=grid")).text();
    expect(grid).toContain('data-view="grid"');

    const invalid = await (await respond(dir, "http://localhost/?view=wat")).text();
    expect(invalid).toContain('data-view="grid"');
    expect(invalid).toContain('class="view-option is-active" data-view-link="grid"');
  });

  test("grid cards escape names and encode image links", async () => {
    const dir = fixtureDir("grid-escape");
    mkdirSync(join(dir, "a&b"));
    writeFileSync(join(dir, 'q"u&t.png'), "");
    const html = await (await respond(dir, "http://localhost/?view=grid")).text();
    const grid = html.slice(html.indexOf('data-view-panel="grid"'));

    expect(grid).toContain('title="a&amp;b"');
    expect(grid).toContain("a&amp;b/");
    expect(grid).toContain('href="a%26b/"');
    expect(grid).toContain('title="q&quot;u&amp;t.png"');
    expect(grid).toContain("q&quot;u&amp;t.png");
    expect(grid).toContain('src="q%22u%26t.png"');
    expect(grid).toContain('href="q%22u%26t.png"');
  });

  test("both views cap at 300 and Show all lifts both", async () => {
    const dir = fixtureDir("grid-cap");
    const total = ENTRY_LIMIT + 5;
    for (let i = 0; i < total; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");

    const capped = await (await respond(dir, "http://localhost/?view=grid")).text();
    expect(capped.match(/class="grid-card"/g)?.length).toBe(ENTRY_LIMIT);
    expect(capped.match(/<td class="name">/g)?.length).toBe(ENTRY_LIMIT);
    expect(capped).toContain('href="?view=grid&amp;showall=1"');
    expect(capped).toContain('href="?view=list&amp;showall=1"');
    expect(capped).toContain(`Show all ${total}`);

    const cappedList = await (await respond(dir, "http://localhost/?view=list")).text();
    expect(cappedList.match(/class="grid-card"/g)?.length).toBe(ENTRY_LIMIT);
    expect(cappedList.match(/<td class="name">/g)?.length).toBe(ENTRY_LIMIT);
    expect(cappedList).toContain('href="?view=list&amp;showall=1"');

    const all = await (await respond(dir, "http://localhost/?view=grid&showall=1")).text();
    expect(all.match(/class="grid-card"/g)?.length).toBe(total);
    expect(all.match(/<td class="name">/g)?.length).toBe(total);
    expect(all).not.toContain("Show all");

    const allList = await (await respond(dir, "http://localhost/?view=list&showall=1")).text();
    expect(allList.match(/<td class="name">/g)?.length).toBe(total);
    expect(allList).not.toContain("Show all");
  });

  test("showall is on only for 1, true or a bare parameter", async () => {
    const dir = fixtureDir("showall");
    const total = ENTRY_LIMIT + 1;
    for (let i = 0; i < total; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");
    const toggleHrefs = (html: string) =>
      [...html.matchAll(/<a class="view-option[^"]*" data-view-link="[^"]*" href="([^"]*)"/g)].map((m) => m[1]);

    for (const query of ["showall=0", "showall=false", "showall="]) {
      const html = await (await respond(dir, `http://localhost/?view=grid&${query}`)).text();
      expect(html.match(/class="grid-card"/g)?.length).toBe(ENTRY_LIMIT);
      expect(html).toContain("Show all");
      expect(toggleHrefs(html)).toEqual(["?view=list", "?view=grid"]);
    }

    for (const query of ["showall=1", "showall=true", "showall"]) {
      const html = await (await respond(dir, `http://localhost/?view=grid&${query}`)).text();
      expect(html.match(/class="grid-card"/g)?.length).toBe(total);
      expect(html).not.toContain("Show all");
      expect(toggleHrefs(html)).toEqual([
        "?view=list&amp;showall=1",
        "?view=grid&amp;showall=1",
      ]);
    }
  });

  test("every page carries an inline SVG favicon", async () => {
    const dir = fixtureDir("favicon-page");
    writeFileSync(join(dir, "a.txt"), "a");
    writeFileSync(join(dir, "note.md"), "# note\n");

    for (const path of ["/", "/a.txt", "/note.md", "/missing"]) {
      const html = await (await respond(dir, `http://localhost${path}`)).text();
      const match = html.match(/<link rel="icon" type="image\/svg\+xml" href="([^"]+)">/);
      expect(match).not.toBeNull();
      const href = match![1]!;
      expect(href.startsWith("data:image/svg+xml,")).toBe(true);
      const svg = decodeURIComponent(href.slice(href.indexOf(",") + 1));
      expect(svg).toContain('<rect width="32" height="32" rx="7" fill="#0064e0"/>');
      expect(svg).toContain("@media (prefers-color-scheme: dark){rect{fill:#0171e3}}");
      expect(svg).toContain('font-size="28"');
      expect(svg).toContain('font-weight="800"');
      expect(svg).toContain('fill="#fff">s</text>');
    }
  });

  test("/favicon.ico is 204 unless the root has a real file", async () => {
    const dir = fixtureDir("favicon-route");
    const absent = await respond(dir, "http://localhost/favicon.ico");
    expect(absent.status).toBe(204);
    expect(await absent.text()).toBe("");

    const ico = Buffer.from([0, 0, 1, 0, 0, 0]);
    writeFileSync(join(dir, "favicon.ico"), ico);
    const real = await respond(dir, "http://localhost/favicon.ico");
    expect(real.status).toBe(200);
    expect(Array.from(new Uint8Array(await real.arrayBuffer()))).toEqual(Array.from(ico));
  });

  test("the current directory breadcrumb keeps its trailing slash", async () => {
    const dir = fixtureDir("crumb-slash");
    mkdirSync(join(dir, "docs"));
    const html = await (await respond(dir, "http://localhost/docs/")).text();
    expect(html).toContain('href="/docs/" title="docs" aria-current="page"');
  });

  test("an empty folder says so instead of showing a bare table header", async () => {
    const dir = fixtureDir("empty-dir");
    mkdirSync(join(dir, "empty"));
    const html = await (await respond(dir, "http://localhost/empty/")).text();
    expect(html).toContain("This folder is empty.");
    expect(html).not.toContain('<table class="listing">');
  });
});

describe("sidebar", () => {
  test("expands only the ancestors of the current page and marks the active entry", async () => {
    const dir = fixtureDir("tree-active");
    mkdirSync(join(dir, "docs", "guide"), { recursive: true });
    mkdirSync(join(dir, "other"));
    writeFileSync(join(dir, "docs", "guide", "page.md"), "# Hi\n");
    writeFileSync(join(dir, "other", "hidden.md"), "x\n");
    writeFileSync(join(dir, "root.txt"), "x\n");

    const html = await (await respond(dir, "http://localhost/docs/guide/page.md")).text();

    expect(html).toContain('<aside class="sidebar" id="serv-tree">');
    expect(html).toContain('aria-controls="serv-tree"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<details open data-src="/docs/" data-loaded="1">');
    expect(html).toContain('<details open data-src="/docs/guide/" data-loaded="1">');
    expect(html).toContain('<details data-src="/other/" data-loaded="0">');
    expect(html.match(/<details open/g)?.length).toBe(2);
    expect(html).toContain('<a href="/docs/guide/page.md" aria-current="page">page.md</a>');
    expect(html).not.toContain("hidden.md"); // a collapsed folder is not read
  });

  test("the narrow drawer has a no-script layout", async () => {
    const dir = fixtureDir("noscript");
    writeFileSync(join(dir, "note.md"), "# Hi\n");
    const html = await (await respond(dir, "http://localhost/note.md")).text();
    expect(html).toContain("<noscript><style>@media (max-width: 799.98px)");
    expect(html).toContain("position: static");
    expect(html).toContain(".nav-btn, .nav-close, .nav-backdrop { display: none; }");
  });

  test("caps each folder and links the rest to the full listing", () => {
    const dir = fixtureDir("tree-cap");
    for (let i = 0; i < MAX_TREE_ENTRIES + 5; i++) writeFileSync(join(dir, `f${String(i).padStart(3, "0")}.txt`), "x");

    const html = renderSidebar(dir, "", undefined, readTreeLevels(dir, "", true));
    expect(html.match(/<li class="f"/g)?.length).toBe(MAX_TREE_ENTRIES);
    expect(html).toContain('<a href="/" style="--depth:0">… 5 more</a>');
  });

  test.skipIf(!Bun.which("git"))("a directory page tags the current level's sidebar rows", async () => {
    const dir = fixtureDir("tree-dir-tags");
    initRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, "docs", "guide"), { recursive: true });
    writeFileSync(join(dir, "docs", "guide", "note.md"), "x\n");
    writeFileSync(join(dir, "docs", "guide", "skip.log"), "x\n");
    writeFileSync(join(dir, "docs", "guide", ".dot"), "x\n");

    const html = await (await respond(dir, "http://localhost/docs/guide/")).text();
    const sidebar = html.slice(html.indexOf('<aside class="sidebar"'), html.indexOf("</aside>"));
    const rowFor = (href: string) =>
      sidebar.split("</li>").find((row) => row.includes(`href="${href}"`)) ?? "";

    // The current directory is the deepest expanded level; its tags come from tagRows.
    expect(rowFor("/docs/guide/skip.log")).toContain("data-ignored");
    expect(rowFor("/docs/guide/.dot")).toContain("data-hidden");
    expect(rowFor("/docs/guide/note.md")).not.toContain("data-hidden");
  });

  test("?tree returns an escaped fragment and rejects traversal", async () => {
    const dir = fixtureDir("tree-frag");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "a<b>.md"), "x\n");
    writeFileSync(join(dir, "sub", "plain.md"), "x\n");

    const res = await respond(dir, "http://localhost/sub/?tree");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const frag = await res.text();
    expect(frag.startsWith("<ul>")).toBe(true);
    expect(frag).toContain('href="/sub/a%3Cb%3E.md"');
    expect(frag).toContain("a&lt;b&gt;.md");
    expect(frag).not.toContain("<html");

    // %2f keeps the escape in one segment, so it reaches resolveRequest undecoded.
    const denied = await respond(dir, "http://localhost/sub/%2e%2e%2fsecret/?tree");
    expect(denied.status).toBe(403);
  });
});

describe("sidebar depth", () => {
  test("rows carry the parent directory's depth, including ?tree fragments", async () => {
    const dir = fixtureDir("tree-depth");
    mkdirSync(join(dir, "one", "two"), { recursive: true });
    writeFileSync(join(dir, "root.md"), "x\n");
    writeFileSync(join(dir, "one", "sibling.md"), "x\n");
    writeFileSync(join(dir, "one", "two", "deep.md"), "x\n");
    writeFileSync(join(dir, "one", "two", "sibling.md"), "x\n");

    const html = await (await respond(dir, "http://localhost/one/two/deep.md")).text();
    expect(html).toContain('<summary style="--depth:0">'); // one/
    expect(html).toContain('<summary style="--depth:1">'); // one/two/
    expect(html).toContain('<li class="f" style="--depth:2">'); // one/two/sibling.md
    expect(html).toContain('<li class="f" style="--depth:1">'); // one/sibling.md
    expect(html).toContain('<li class="f" style="--depth:0">'); // root.md

    const frag = await (await respond(dir, "http://localhost/one/two/?tree")).text();
    expect(frag.startsWith("<ul>")).toBe(true);
    expect(frag).toContain('<li class="f" style="--depth:2">');
    expect(frag).toContain('href="/one/two/deep.md"');
  });

  test("the more row carries the depth of the level it ends", () => {
    const dir = fixtureDir("tree-depth-more");
    mkdirSync(join(dir, "a", "b"), { recursive: true });
    for (let i = 0; i < MAX_TREE_ENTRIES + 2; i++) writeFileSync(join(dir, "a", "b", `f${i}.txt`), "x");

    const frag = renderTreeFragment("a/b", undefined, readTreeLevel(dir, "a/b"));
    expect(frag).toContain('style="--depth:2">… 2 more</a>');
  });
});

describe("source view", () => {
  test("text sources get the shell and line numbers; ?raw stays plain; JSON and images pass through", async () => {
    const dir = fixtureDir("source");
    writeFileSync(join(dir, "app.ts"), "const a = 1;\nif (a < 2) {\n  run();\n}\n");
    writeFileSync(join(dir, "data.json"), '{"a":1}\n');
    // 1x1 transparent PNG.
    writeFileSync(
      join(dir, "pixel.png"),
      Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
    );

    const page = await respond(dir, "http://localhost/app.ts");
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("vary")).toBe("Sec-Fetch-Dest");
    const html = await page.text();
    expect(html).toContain('<aside class="sidebar"');
    expect(html).toContain('<div class="source">');
    expect(html).not.toContain('class="md-view"');
    expect(html).not.toContain('class="md-panel"');
    expect(html).toContain('<pre class="gutter" aria-hidden="true">1\n2\n3\n4</pre>');
    expect(html).toContain('<span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">const</span>');
    expect(html).toContain('<span style="--shiki-light:#D73A49;--shiki-dark:#F97583;">if</span>');
    expect(html).toContain("&lt;");
    expect(html).toContain('href="/app.ts?raw"');

    const raw = await respond(dir, "http://localhost/app.ts?raw");
    expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await raw.text()).toBe("const a = 1;\nif (a < 2) {\n  run();\n}\n");

    const json = await respond(dir, "http://localhost/data.json");
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(await json.text()).toBe('{"a":1}\n');

    const png = await respond(dir, "http://localhost/pixel.png");
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  test("xml, lock and named dotfiles render source; extensionless text still does", async () => {
    const dir = fixtureDir("text-types");
    writeFileSync(join(dir, "feed.xml"), "<root>xml-marker</root>");
    writeFileSync(join(dir, "bun.lock"), "lock-marker\n");
    writeFileSync(join(dir, "LICENSE"), "MIT-marker\n");
    writeFileSync(join(dir, ".env.example"), "ENV_MARKER=1\n");
    writeFileSync(join(dir, ".gitignore"), "gitignore-marker\n");
    writeFileSync(join(dir, "table.csv"), "csv-marker,1\n");

    for (const [path, marker] of [
      ["feed.xml", "xml-marker"],
      ["bun.lock", "lock-marker"],
      ["LICENSE", "MIT-marker"],
      [".env.example", "ENV_MARKER=1"],
      [".gitignore", "gitignore-marker"],
      ["table.csv", "csv-marker"],
    ] as const) {
      const res = await respond(dir, `http://localhost/${path}`);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const html = await res.text();
      expect(html).toContain('<div class="source">');
      expect(html).toContain(marker);
    }
  });
});

describe("file viewers and request destination", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const withDest = (dest: string) => ({ "sec-fetch-dest": dest });
  const documentNav = withDest("document");

  test("Sec-Fetch-Dest: document gets viewers; image/iframe/none get raw bytes; ?raw overrides", async () => {
    const dir = fixtureDir("dest");
    writeFileSync(join(dir, "pixel.png"), PNG);
    writeFileSync(join(dir, "page.html"), "<h1>hello</h1>");
    writeFileSync(join(dir, "doc.pdf"), "%PDF-1.4 fake");

    const pngDoc = await respond(dir, "http://localhost/pixel.png", documentNav);
    expect(pngDoc.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(pngDoc.headers.get("vary")).toBe("Sec-Fetch-Dest");
    const pngHtml = await pngDoc.text();
    expect(pngHtml).toContain('<aside class="sidebar"');
    expect(pngHtml).toContain('class="image-viewer"');
    expect(pngHtml).toContain('src="/pixel.png?raw"');

    for (const headers of [withDest("image"), withDest("empty"), undefined]) {
      const res = await respond(dir, "http://localhost/pixel.png", headers);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("vary")).toBe("Sec-Fetch-Dest");
      expect(Buffer.from(await res.arrayBuffer()).toString("base64")).toBe(PNG.toString("base64"));
    }

    const forced = await respond(dir, "http://localhost/pixel.png?raw", documentNav);
    expect(forced.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await forced.arrayBuffer()).toString("base64")).toBe(PNG.toString("base64"));

    const htmlShell = await (await respond(dir, "http://localhost/page.html", documentNav)).text();
    expect(htmlShell).toContain('<aside class="sidebar"');
    expect(htmlShell).toContain('<iframe class="viewer-frame" src="/page.html"');

    for (const headers of [withDest("iframe"), undefined]) {
      const res = await respond(dir, "http://localhost/page.html", headers);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("vary")).toBe("Sec-Fetch-Dest");
      expect(await res.text()).toBe("<h1>hello</h1>");
    }

    const pdf = await (await respond(dir, "http://localhost/doc.pdf", documentNav)).text();
    expect(pdf).toContain('<iframe class="viewer-frame" src="/doc.pdf?raw"');
  });

  test("non-document destinations get the file's own type for CSS, JS and Markdown", async () => {
    const dir = fixtureDir("dest-text");
    writeFileSync(join(dir, "style.css"), "body { color: red }");
    writeFileSync(join(dir, "app.js"), "console.log(1)\n");
    writeFileSync(join(dir, "note.md"), "# Hi\n");

    const css = await respond(dir, "http://localhost/style.css", withDest("style"));
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(css.headers.get("vary")).toBe("Sec-Fetch-Dest");
    expect(await css.text()).toBe("body { color: red }");

    const js = await respond(dir, "http://localhost/app.js", withDest("script"));
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("vary")).toBe("Sec-Fetch-Dest");
    expect(await js.text()).toBe("console.log(1)\n");

    for (const dest of ["iframe", "empty"]) {
      const md = await respond(dir, "http://localhost/note.md", withDest(dest));
      expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(md.headers.get("vary")).toBe("Sec-Fetch-Dest");
      expect(await md.text()).toBe("# Hi\n");
    }

    // With no header the text file still opens in the shell.
    const shell = await respond(dir, "http://localhost/style.css");
    expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(shell.headers.get("vary")).toBe("Sec-Fetch-Dest");
  });

  test("HEAD returns response headers without a body", async () => {
    const dir = fixtureDir("head");
    writeFileSync(join(dir, "note.md"), "# Hi\n");
    writeFileSync(join(dir, "pixel.png"), PNG);

    const pageGet = await respond(dir, "http://localhost/note.md");
    const page = await respond(dir, "http://localhost/note.md", undefined, "HEAD");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-length")).toBe(pageGet.headers.get("content-length"));
    expect(Number(page.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await page.text()).toBe("");

    const viewerGet = await respond(dir, "http://localhost/pixel.png", documentNav);
    const viewer = await respond(dir, "http://localhost/pixel.png", documentNav, "HEAD");
    expect(viewer.status).toBe(200);
    expect(viewer.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(viewer.headers.get("content-length")).toBe(viewerGet.headers.get("content-length"));
    expect(Number(viewer.headers.get("content-length"))).toBeGreaterThan(0);
    expect(await viewer.text()).toBe("");

    const missing = await respond(dir, "http://localhost/nope.md", undefined, "HEAD");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("");
  });

  test("raw files honour one byte range, suffix and open-ended forms", async () => {
    const dir = fixtureDir("ranges");
    const bytes = "0123456789";
    writeFileSync(join(dir, "data.bin"), bytes);
    const get = (range: string, url = "http://localhost/data.bin") =>
      respond(dir, url, { range });

    for (const [range, body, contentRange] of [
      ["bytes=0-2", "012", "bytes 0-2/10"],
      ["bytes=4-6", "456", "bytes 4-6/10"],
      ["bytes=7-9", "789", "bytes 7-9/10"],
      ["bytes=-3", "789", "bytes 7-9/10"],
      ["bytes=5-", "56789", "bytes 5-9/10"],
    ] as const) {
      const res = await get(range);
      expect(res.status).toBe(206);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-range")).toBe(contentRange);
      expect(res.headers.get("content-length")).toBe(String(body.length));
      expect(await res.text()).toBe(body);
    }

    const video = await respond(dir, "http://localhost/data.bin", {
      "sec-fetch-dest": "video",
      range: "bytes=0-1",
    });
    expect(video.status).toBe(206);
    expect(await video.text()).toBe("01");

    const out = await get("bytes=99-100");
    expect(out.status).toBe(416);
    expect(out.headers.get("accept-ranges")).toBe("bytes");
    expect(out.headers.get("content-range")).toBe("bytes */10");
    expect(out.headers.get("content-length")).toBe("0");
    expect(await out.text()).toBe("");

    for (const bad of ["bytes=0-1,3-4", "bytes=abc", "bytes=5-4"]) {
      const res = await get(bad);
      expect(res.status).toBe(200);
      expect(res.headers.get("accept-ranges")).toBe("bytes");
      expect(res.headers.get("content-length")).toBe("10");
      expect(await res.text()).toBe(bytes);
    }

    const getHead = await get("bytes=4-6");
    const head = await respond(dir, "http://localhost/data.bin", { range: "bytes=4-6" }, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers.get("accept-ranges")).toBe("bytes");
    expect(head.headers.get("content-range")).toBe(getHead.headers.get("content-range"));
    expect(head.headers.get("content-length")).toBe(getHead.headers.get("content-length"));
    expect(await head.text()).toBe("");

    const raw = await respond(dir, "http://localhost/data.bin?raw", {
      ...documentNav,
      range: "bytes=-2",
    });
    expect(raw.status).toBe(206);
    expect(raw.headers.get("content-range")).toBe("bytes 8-9/10");
    expect(await raw.text()).toBe("89");
  });

  test("image viewer steps through images in listing order", async () => {
    const dir = fixtureDir("image-steps");
    for (const name of ["a.png", "b.png", "c.png"]) writeFileSync(join(dir, name), PNG);
    writeFileSync(join(dir, "note.txt"), "not an image");
    mkdirSync(join(dir, "zdir"));
    // An image-named symlink to a folder must not become a neighbour.
    symlinkSync(join(dir, "zdir"), join(dir, "b0.png"));

    const first = await (await respond(dir, "http://localhost/a.png", documentNav)).text();
    expect(first).toContain("1 / 3");
    expect(first).toContain('<a class="image-step" rel="next" href="/b.png"');
    expect(first).not.toContain('<a class="image-step" rel="prev"');

    const middle = await (await respond(dir, "http://localhost/b.png", documentNav)).text();
    expect(middle).toContain("2 / 3");
    expect(middle).toContain('<a class="image-step" rel="prev" href="/a.png"');
    expect(middle).toContain('<a class="image-step" rel="next" href="/c.png"');

    const last = await (await respond(dir, "http://localhost/c.png", documentNav)).text();
    expect(last).toContain("3 / 3");
    expect(last).toContain('<a class="image-step" rel="prev" href="/b.png"');
    expect(last).not.toContain('<a class="image-step" rel="next"');
  });

  test("image viewer hrefs and labels escape awkward filenames", async () => {
    const dir = fixtureDir("image-names");
    writeFileSync(join(dir, "a<&\"'.png"), PNG);
    writeFileSync(join(dir, "m.png"), PNG);
    writeFileSync(join(dir, "z>`&.png"), PNG);

    const html = await (await respond(dir, "http://localhost/m.png", documentNav)).text();
    expect(html).toContain("2 / 3");
    expect(html).toContain('rel="prev" href="/a%3C%26%22&#39;.png"');
    expect(html).toContain('aria-label="Previous image: a&lt;&amp;&quot;&#39;.png"');
    expect(html).toContain('rel="next" href="/z%3E%60%26.png"');
    expect(html).toContain('aria-label="Next image: z&gt;`&amp;.png"');
  });

  test("image viewer neighbours stay inside a nested folder", async () => {
    const dir = fixtureDir("image-nested");
    mkdirSync(join(dir, "pics"));
    for (const name of ["a.png", "b.png", "c.png"]) writeFileSync(join(dir, "pics", name), PNG);

    const html = await (await respond(dir, "http://localhost/pics/b.png", documentNav)).text();
    expect(html).toContain("2 / 3");
    expect(html).toContain('rel="prev" href="/pics/a.png"');
    expect(html).toContain('rel="next" href="/pics/c.png"');
  });

  test("JSON and .map pretty-print in the source view; invalid JSON falls back to text", async () => {
    const dir = fixtureDir("json");
    writeFileSync(join(dir, "data.json"), '{"b":2,"a":1}');
    writeFileSync(join(dir, "bundle.map"), '{"version":3,"sources":["a.ts"]}');
    writeFileSync(join(dir, "broken.json"), "{oops\n");

    const pretty = await (await respond(dir, "http://localhost/data.json", documentNav)).text();
    expect(pretty).toContain('<pre class="gutter"');
    expect(pretty).toContain("&quot;b&quot;</span>");
    expect(pretty).toContain("&quot;a&quot;</span>");
    expect(pretty).toContain('href="/data.json?raw"');
    expect(pretty).toContain("raw ↗");

    const map = await (await respond(dir, "http://localhost/bundle.map", documentNav)).text();
    expect(map).toContain("&quot;version&quot;</span>");

    const broken = await (await respond(dir, "http://localhost/broken.json", documentNav)).text();
    expect(broken).toContain("{oops");

    const rawJson = await respond(dir, "http://localhost/data.json", withDest("empty"));
    expect(rawJson.headers.get("content-type")).toContain("application/json");
    expect(rawJson.headers.get("vary")).toBe("Sec-Fetch-Dest");
    expect(await rawJson.text()).toBe('{"b":2,"a":1}');
  });

  test("large files are capped at 1 MB with a notice and a link to ?raw", async () => {
    const dir = fixtureDir("cap");
    const big = "x".repeat(SOURCE_LIMIT + 10) + "TAIL-MARKER";
    writeFileSync(join(dir, "big.txt"), big);

    const html = await (await respond(dir, "http://localhost/big.txt")).text();
    expect(html).toContain("Showing the first 1.0 MB of this file");
    expect(html).toContain('href="/big.txt?raw"');
    expect(html).not.toContain("TAIL-MARKER");

    const full = await respond(dir, "http://localhost/big.txt?raw");
    expect((await full.text()).length).toBe(big.length);

    const bigMd = "# Big\n\n" + "x".repeat(SOURCE_LIMIT) + "\nTAIL-MARKER\n";
    writeFileSync(join(dir, "big.md"), bigMd);
    const markdown = await (await respond(dir, "http://localhost/big.md")).text();
    expect(markdown).toContain("Showing the first 1.0 MB of this file");
    expect(markdown).toContain('href="/big.md?raw"');
    expect(markdown).not.toContain("TAIL-MARKER");

    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "README.md"), bigMd);
    const listing = await (await respond(dir, "http://localhost/docs/")).text();
    expect(listing).toContain("Showing the first 1.0 MB of this file");
    expect(listing).toContain('href="/docs/README.md?raw"');
    expect(listing).not.toContain("TAIL-MARKER");
  });

  test("the byte cap does not split a UTF-8 character", async () => {
    const dir = fixtureDir("utf8-cap");
    writeFileSync(join(dir, "big.txt"), "a".repeat(SOURCE_LIMIT - 1) + "é");

    const html = await (await respond(dir, "http://localhost/big.txt")).text();
    expect(html).not.toContain("�");
    expect(html).toContain("Showing the first 1.0 MB of this file");
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

  test("a root of / still resolves children", () => {
    expect(resolveRequest("/", "/etc/hosts")).toEqual({
      kind: "file",
      path: "/etc/hosts",
      rel: "etc/hosts",
    });
  });

  test("a root of / gets a non-empty label", async () => {
    const res = await respond("/", "http://localhost/no-such-root-label");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("&larr; /</a>");
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
    expect(body).toContain("If this came from a relative link that goes above the served folder");
  });

  test("the 404 parent listing href is encoded", async () => {
    const dir = fixtureDir("notfound-encoded");
    const res = await respond(dir, "http://localhost/a%20b/nope%20file.md");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('href="/a%20b/"');
    expect(body).toContain("<code>/a b/nope file.md</code>");
  });

  test("a missing directory's parent link drops its trailing slash", async () => {
    const dir = fixtureDir("notfound-dir");
    const res = await respond(dir, "http://localhost/qa/nope/deeper/");
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain("<code>/qa/nope/deeper/</code>");
    expect(body).toContain('<a href="/qa/nope/">parent listing</a>');
    expect(body).not.toContain('href="/qa/nope/deeper/"');
  });

  test("a directory redirect keeps the query string", async () => {
    const dir = fixtureDir("redirect-query");
    mkdirSync(join(dir, "docs"));
    const res = await respond(dir, "http://localhost/docs?x=1");
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/docs/?x=1");
  });

  test.skipIf(process.getuid?.() === 0)("unreadable files and folders get a friendly 403 page", async () => {
    const dir = fixtureDir("perms");
    const file = join(dir, "secret.txt");
    writeFileSync(file, "TOP-SECRET");
    chmodSync(file, 0o000);
    try {
      const res = await respond(dir, "http://localhost/secret.txt");
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("Permission denied");
      expect(body).toContain('<aside class="sidebar"');
      expect(body).not.toContain("TOP-SECRET");
    } finally {
      chmodSync(file, 0o644);
    }

    const binary = join(dir, "secret.png");
    writeFileSync(binary, "not really a png");
    chmodSync(binary, 0o000);
    try {
      const res = await respond(dir, "http://localhost/secret.png", { "sec-fetch-dest": "document" });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("Permission denied");
    } finally {
      chmodSync(binary, 0o644);
    }

    const parent = join(dir, "parent");
    mkdirSync(parent);
    const locked = join(parent, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inside.txt"), "inside");
    chmodSync(locked, 0o000);
    try {
      const res = await respond(dir, "http://localhost/parent/locked/");
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(body).toContain("Permission denied");
      expect(body).toContain('<aside class="sidebar"');
      expect(body).toContain("<code>/parent/locked/</code>");
      expect(body).toContain('<a href="/parent/">parent listing</a>');
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test.skipIf(process.getuid?.() === 0 || !Bun.which("git"))(
    "an error page keeps its sidebar when tagging fails",
    async () => {
      const dir = fixtureDir("error-tag-fail");
      initRepo(dir);
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs", "note.md"), "x");
      const locked = join(dir, "locked.txt");
      writeFileSync(locked, "x");
      chmodSync(locked, 0o000);

      const original = Bun.spawn;
      const stub = (...args: unknown[]) => {
        const command = args[0];
        if (Array.isArray(command) && command.includes("check-ignore")) throw new Error("git unavailable");
        return (original as (...a: unknown[]) => unknown)(...args);
      };
      (Bun as unknown as { spawn: typeof stub }).spawn = stub;
      try {
        const res = await respond(dir, "http://localhost/locked.txt", { "sec-fetch-dest": "document" });
        expect(res.status).toBe(403);
        const body = await res.text();
        expect(body).toContain("Permission denied");
        // tagRows failed, but the tree was already read.
        expect(body).toContain('href="/docs/"');
        expect(body).toContain('href="/locked.txt"');
      } finally {
        (Bun as unknown as { spawn: typeof original }).spawn = original;
        chmodSync(locked, 0o644);
      }
    },
  );

  test("special characters are escaped in the tree, listing, breadcrumbs, title and 404", async () => {
    const dir = fixtureDir("escape");
    const folder = "a&b";
    const name = "q\"u'o&t`e.md";
    mkdirSync(join(dir, folder));
    writeFileSync(join(dir, folder, name), "# Hi\n");
    const rel = `/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`;

    const page = await (await respond(dir, "http://localhost" + rel)).text();
    const label = "q&quot;u&#39;o&amp;t`e.md";
    expect(page).toContain("a&amp;b/");
    expect(page).toContain(label);
    expect(page).toContain('title="a&amp;b"');
    expect(page).toContain(`<title>${label}</title>`);
    expect(page).toContain('href="/a%26b/"');

    const listing = await (await respond(dir, "http://localhost/a%26b/")).text();
    expect(listing).toContain(label);
    expect(listing).toContain('title="a&amp;b"');

    const notFound = await (await respond(dir, "http://localhost/a%26b/missing%22.md")).text();
    expect(notFound).toContain("<code>/a&amp;b/missing&quot;.md</code>");
    expect(notFound).toContain('href="/a%26b/"');
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

describe("cli arguments", () => {
  test("parses path, port, base and --no-open", () => {
    expect(parseArgs(["--port", "5000", "--no-open", "--base", "/tmp", "docs"], "/work")).toEqual({
      path: "docs",
      base: "/tmp",
      port: 5000,
      open: false,
    });
    expect(parseArgs(["--port=5001", "--base=/tmp"], "/work")).toEqual({
      path: ".",
      base: "/tmp",
      port: 5001,
      open: true,
    });
    expect(parseArgs([], "/work")).toEqual({ path: ".", base: "/work", port: 4400, open: true });
  });

  test("rejects unknown flags and bad values", () => {
    expect(() => parseArgs(["--wat"])).toThrow("unknown flag: --wat");
    expect(() => parseArgs(["--port"])).toThrow("--port needs a value");
    expect(() => parseArgs(["--base"])).toThrow("--base needs a value");
    expect(() => parseArgs(["--port", "nope"])).toThrow("bad port: nope");
    expect(() => parseArgs(["a", "b"])).toThrow("expected one path, got 2");
  });
});

describe("command palette", () => {
  const FILES_PATHS = [
    ".gitignore",
    ".hidden.md",
    "README.md",
    "node_modules/",
    "node_modules/pkg/",
    "node_modules/pkg/x.js",
    "secret.txt",
    "sub/",
    "sub/a.md",
    "sub/deep/",
    "sub/deep/b.txt",
    "sub/node_modules/",
    "sub/node_modules/deep/",
    "sub/node_modules/deep/y.js",
  ];

  function filesFixture(name: string): string {
    const dir = fixtureDir(name);
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    mkdirSync(join(dir, "sub", "node_modules", "deep"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".gitignore"), "node_modules/\nsecret.txt\n");
    writeFileSync(join(dir, "README.md"), "x");
    writeFileSync(join(dir, "secret.txt"), "x");
    writeFileSync(join(dir, "sub", "a.md"), "x");
    writeFileSync(join(dir, "sub", "deep", "b.txt"), "x");
    writeFileSync(join(dir, "sub", "node_modules", "deep", "y.js"), "x");
    writeFileSync(join(dir, "node_modules", "pkg", "x.js"), "x");
    writeFileSync(join(dir, ".hidden.md"), "x");
    writeFileSync(join(dir, ".git", "config"), "x");
    return dir;
  }

  async function withoutRg<T>(run: () => Promise<T>): Promise<T> {
    const saved = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      return await run();
    } finally {
      process.env.PATH = saved;
    }
  }

  test.skipIf(!Bun.which("rg"))(
    "?files lists tagged paths relative to the folder, folders with a trailing slash",
    async () => {
      const dir = filesFixture("files");

      const res = await respond(dir, "http://localhost/?files");
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      const body = (await res.json()) as {
        entries: Array<{ path: string; hidden?: boolean; ignored?: boolean }>;
      };
      const byPath = new Map(body.entries.map((entry) => [entry.path, entry]));

      // Path order on every backend, ignored entries included.
      expect(body.entries.map((entry) => entry.path)).toEqual(FILES_PATHS);
      expect(byPath.get(".gitignore")).toEqual({ path: ".gitignore", hidden: true });
      expect(byPath.get(".hidden.md")).toEqual({ path: ".hidden.md", hidden: true });
      expect(byPath.get("node_modules/")).toEqual({ path: "node_modules/", ignored: true });
      expect(byPath.get("node_modules/pkg/x.js")).toEqual({ path: "node_modules/pkg/x.js", ignored: true });
      expect(byPath.get("secret.txt")).toEqual({ path: "secret.txt", ignored: true });
      expect(byPath.get("sub/node_modules/")).toEqual({ path: "sub/node_modules/", ignored: true });
      expect(byPath.has(".git/")).toBe(false);
      expect(byPath.has(".git/config")).toBe(false);

      // Relative to the requested folder, not to the root.
      const nested = (await (await respond(dir, "http://localhost/sub/?files")).json()) as {
        entries: Array<{ path: string; ignored?: boolean }>;
      };
      expect(nested.entries.map((entry) => entry.path)).toEqual([
        "a.md",
        "deep/",
        "deep/b.txt",
        "node_modules/",
        "node_modules/deep/",
        "node_modules/deep/y.js",
      ]);
      expect(nested.entries.find((entry) => entry.path === "node_modules/")?.ignored).toBe(true);
    },
  );

  test("?files without ripgrep keeps the path order and tags only dotfiles", async () => {
    const dir = filesFixture("files-no-rg");
    const body = await withoutRg(async () => {
      const res = await respond(dir, "http://localhost/?files");
      return (await res.json()) as {
        entries: Array<{ path: string; hidden?: boolean; ignored?: boolean }>;
      };
    });

    expect(body.entries.map((entry) => entry.path)).toEqual(FILES_PATHS);
    expect(body.entries.filter((entry) => entry.ignored)).toEqual([]);
    expect(body.entries.filter((entry) => entry.hidden).map((entry) => entry.path)).toEqual([
      ".gitignore",
      ".hidden.md",
    ]);
  });




  test.skipIf(!Bun.which("rg"))(
    "?files keeps a parent-ignored folder, but tags the tree's own ignored files",
    async () => {
      const base = fixtureDir("files-parent-ignore");
      mkdirSync(join(base, ".git")); // ripgrep honours .gitignore inside a repo
      writeFileSync(join(base, ".gitignore"), "child/**\n");
      const child = join(base, "child");
      mkdirSync(child);
      writeFileSync(join(child, ".gitignore"), "secret.txt\n");
      writeFileSync(join(child, "inside.txt"), "x");
      writeFileSync(join(child, "secret.txt"), "x");

      const res = await respond(child, "http://localhost/?files");
      expect(await res.json()).toEqual({
        entries: [
          { path: ".gitignore", hidden: true },
          { path: "inside.txt" },
          { path: "secret.txt", ignored: true },
        ],
        truncated: false,
      });
    },
  );


  test("?files refuses traversal and cannot list outside the root", async () => {
    const base = fixtureDir("files-trav");
    const root = join(base, "root");
    mkdirSync(root);
    writeFileSync(join(base, "secret.txt"), "TOP-SECRET");
    writeFileSync(join(root, "inside.txt"), "inside");

    // %2f keeps the escape in one segment, so it reaches resolveRequest undecoded.
    const denied = await respond(root, "http://localhost/%2e%2e%2fsecret/?files");
    expect(denied.status).toBe(403);
    expect(await denied.text()).not.toContain("TOP-SECRET");

    const ok = await respond(root, "http://localhost/?files");
    expect(await ok.json()).toEqual({ entries: [{ path: "inside.txt" }], truncated: false });
  });

  test("names are delivered as JSON data", async () => {
    const dir = fixtureDir("files-data");
    const name = `<img src=x onerror=alert(1)>.md`;
    writeFileSync(join(dir, name), "x");

    const res = await respond(dir, "http://localhost/?files");
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ entries: [{ path: name }], truncated: false });
  });




  test.skipIf(!Bun.which("git"))("the indicator counts each hidden entry once", async () => {
    const dir = fixtureDir("files-indicator");
    initRepo(dir);
    writeFileSync(join(dir, ".gitignore"), "dist/\n.cache\n");
    writeFileSync(join(dir, ".cache"), "x"); // both a dotfile and ignored
    writeFileSync(join(dir, ".env"), "x");
    writeFileSync(join(dir, ". <img>.txt"), "x");
    writeFileSync(join(dir, "keep.txt"), "x");
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "bundle.js"), "x");

    const html = await (await respond(dir, "http://localhost/")).text();
    // .cache, .env, .gitignore, ". <img>.txt" and dist/ => five rows.
    expect(html).toContain('data-serv-hidden-count aria-label="Show 5 hidden entries" title="Shift+H dotfiles · Shift+I ignored">5 hidden</button>');
    expect(html).toContain('<tr data-hidden data-ignored>');
    expect(html).toContain("<tr data-hidden>");
    expect(html).toContain("<tr data-ignored>");
    // Names stay escaped even on a tagged row.
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toContain("<img>.txt");
  });

  test("pages carry the hidden palette dialog and the pre-paint state", async () => {
    const dir = fixtureDir("palette");
    writeFileSync(join(dir, "a.md"), "x");

    const html = await (await respond(dir, "http://localhost/")).text();
    expect(html).toContain('<html lang="en">');
    expect(html).not.toContain('<html lang="en" class=');
    expect(html).toContain('id="serv-palette" hidden');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="serv-search-list"');
    expect(html).toContain('<script type="module">');
    expect(html).toContain('e.classList.add("serv-js")');
    expect(html).toContain("hidden>0 hidden</button>");
    expect(html.indexOf('localStorage.getItem("serv-show-hidden")')).toBeLessThan(html.indexOf("<body"));
  });
});

describe("per-folder tags", () => {

  test.skipIf(!Bun.which("git"))(
    "tags a folder from its own rules even when the scan cap is forced",
    async () => {
      const dir = fixtureDir("tag-rows");
      initRepo(dir);
      writeFileSync(join(dir, ".gitignore"), "out/\n*.log\n!important.log\n");
      mkdirSync(join(dir, "out"));
      writeFileSync(join(dir, "out", "x.txt"), "x");
      writeFileSync(join(dir, "keep.log"), "x");
      writeFileSync(join(dir, "important.log"), "x");
      mkdirSync(join(dir, "sub", "nested"), { recursive: true });
      writeFileSync(join(dir, "sub", ".gitignore"), "nested/\n");
      writeFileSync(join(dir, "sub", "nested", "y.txt"), "x");
      writeFileSync(join(dir, "visible.txt"), "x");
      // A path behind a symlink makes a whole check-ignore batch fail.
      symlinkSync(join(dir, "sub"), join(dir, "linkdir"));
      for (let i = 0; i < 8; i++) writeFileSync(join(dir, `z${i}.txt`), "x");

      const rows = [
        { path: "out/" },
        { path: "keep.log" },
        { path: "important.log" },
        { path: "sub/" },
        { path: "sub/nested/" },
        { path: "visible.txt" },
      ];
      const tags = await tagRows(dir, rows);
      expect(tags.get("out/")).toEqual({ path: "out/", ignored: true });
      expect(tags.get("keep.log")).toEqual({ path: "keep.log", ignored: true });
      expect(tags.has("important.log")).toBe(false); // negated
      expect(tags.get("sub/nested/")).toEqual({ path: "sub/nested/", ignored: true });
      expect(tags.has("sub/")).toBe(false);
      expect(tags.has("visible.txt")).toBe(false);

      // Force the old scan cap: the page must not depend on it for tags.
      const scan = await scanFiles(dir, 2);
      expect(scan.truncated).toBe(true);

      const html = await (await respond(dir, "http://localhost/")).text();
      const table = html.slice(html.indexOf('<table class="listing">'), html.indexOf("</table>"));
      const rowFor = (href: string) =>
        table.split("</tr>").find((row) => row.includes(`href="${href}"`)) ?? "";
      expect(rowFor("out/")).toContain("data-ignored");
      expect(rowFor("keep.log")).toContain("data-ignored");
      expect(rowFor("important.log")).not.toContain("data-ignored");
      expect(html).toContain("3 hidden"); // .gitignore, out/, keep.log
    },
  );




  test("a listing inside a dot-directory reports its hidden rows", async () => {
    const dir = fixtureDir("dotdir");
    mkdirSync(join(dir, ".secret"));
    writeFileSync(join(dir, ".secret", "a.txt"), "x");

    const html = await (await respond(dir, "http://localhost/.secret/")).text();
    expect(html).toContain("<tr data-hidden>");
    expect(html).toContain("1 hidden");
  });

  test("image navigation includes dotfile images", async () => {
    const dir = fixtureDir("image-dots");
    writeFileSync(join(dir, ".cover.png"), "x");
    writeFileSync(join(dir, "b.png"), "x");

    const first = await (
      await respond(dir, "http://localhost/.cover.png", { "sec-fetch-dest": "document" })
    ).text();
    expect(first).toContain("1 / 2");
    expect(first).toContain('aria-label="Next image: b.png"');

    const second = await (
      await respond(dir, "http://localhost/b.png", { "sec-fetch-dest": "document" })
    ).text();
    expect(second).toContain("2 / 2");
    expect(second).toContain('aria-label="Previous image: .cover.png"');
  });
});


describe("search bundle", () => {
  test("src/search.bundle.js is the current build of src/search.ts", () => {
    const root = join(import.meta.dir, "..");
    const out = join(fixtureDir("search-build"), "search.bundle.js");
    const run = Bun.spawnSync(
      [
        process.execPath,
        "build",
        join(root, "src/search.ts"),
        "--minify",
        "--target=browser",
        "--format=esm",
        "--outfile",
        out,
      ],
      { cwd: root, stdout: "ignore", stderr: "pipe" },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(join(root, "src/search.bundle.js"), "utf8"));
  });
});

describe("stylesheet", () => {
  test("src/styles.css is the current build of src/styles.input.css", () => {
    const root = join(import.meta.dir, "..");
    const out = join(fixtureDir("css"), "styles.css");
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(root, "node_modules/@tailwindcss/cli/dist/index.mjs"),
        "-i",
        join(root, "src/styles.input.css"),
        "-o",
        out,
        "--minify",
      ],
      { cwd: root, stdout: "ignore", stderr: "pipe" },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(readFileSync(out, "utf8")).toBe(readFileSync(join(root, "src/styles.css"), "utf8"));
  });

  test("no-JS CSS keeps dotfiles hidden and ignored entries visible", () => {
    const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
    expect(css).toContain("html:not(.serv-show-hidden) [data-hidden]");
    expect(css).toContain("html.serv-js:not(.serv-show-ignored) [data-ignored]");
    expect(css).toContain("html:not(.serv-js) .hidden-count");
  });
});
