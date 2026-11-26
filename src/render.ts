import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** GitHub-like page chrome. One inline stylesheet, no network requests. */
const STYLE = `
:root {
  --fg: #1f2328; --bg: #fff; --muted: #656d76; --line: #d0d7de;
  --code-bg: #f6f8fa; --link: #0969da; --head: #fff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e6edf3; --bg: #0d1117; --muted: #8d96a0; --line: #30363d;
    --code-bg: #161b22; --link: #4493f8; --head: #0d1117;
  }
}
* { box-sizing: border-box; }
html { color-scheme: light dark; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
}
a { color: var(--link); text-decoration: none; }
a:hover { text-decoration: underline; }
header { position: sticky; top: 0; z-index: 10; background: var(--head); border-bottom: 1px solid var(--line); }
header nav {
  display: flex; align-items: center; gap: .4rem; max-width: 900px; margin: 0 auto;
  padding: .6rem 1.25rem; font-size: .875rem; white-space: nowrap; overflow-x: auto;
}
header nav .sep { color: var(--muted); }
header nav [aria-current] { font-weight: 600; }
header nav .raw { margin-left: auto; color: var(--muted); }
main { max-width: 900px; margin: 0 auto; padding: 1.5rem 1.25rem 5rem; }
main .note { color: var(--muted); }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .6em; }
h1 a, h2 a, h3 a, h4 a, h5 a, h6 a { color: inherit; text-decoration: none; }
h1, h2 { padding-bottom: .3em; border-bottom: 1px solid var(--line); }
main > :first-child { margin-top: 0; }
img { max-width: 100%; height: auto; }
code {
  background: var(--code-bg); padding: .15em .35em; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .9em;
}
pre { background: var(--code-bg); padding: 1rem; border: 1px solid var(--line); border-radius: 6px; overflow: auto; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow: auto; margin: 1em 0; }
th, td { border: 1px solid var(--line); padding: .4rem .75rem; }
th { background: var(--code-bg); }
blockquote { margin: 0; padding: 0 1em; color: var(--muted); border-left: .25em solid var(--line); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2em 0; }
ul:has(> .task-list-item) { padding-left: 1.2em; }
.task-list-item { list-style: none; }
table.listing { display: table; width: 100%; }
table.listing th { background: none; border: 0; border-bottom: 1px solid var(--line); text-align: left; }
table.listing td { border: 0; border-top: 1px solid var(--line); padding: .35rem .5rem; }
table.listing .size, table.listing .mtime { color: var(--muted); text-align: right; white-space: nowrap; }
table.listing .entry-dir { font-weight: 600; }
`;

export type Crumb = { label: string; href?: string };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

/**
 * GitHub's slugger, which Bun's own heading ids do not match: it collapses
 * separator runs, so "B1 — Blocker" becomes "b1-blocker" where GitHub keeps
 * "b1--blocker". Documents link across files by GitHub anchor, so ids must too.
 */
export function githubSlug(text: string, seen: Set<string>): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\-_ ]/gu, "")
    .replace(/ /g, "-");
  let slug = base;
  for (let n = 1; seen.has(slug); n++) slug = `${base}-${n}`;
  seen.add(slug);
  return slug;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

const HEADING = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/g;

export function renderMarkdownHtml(markdown: string): string {
  // Bun 1.3 ships a GFM renderer: tables, task lists and autolinks come free.
  const html = Bun.markdown.html(markdown, { autolinks: true });
  const seen = new Set<string>();

  return html.replace(HEADING, (_match, level: string, inner: string) => {
    const slug = escapeHtml(githubSlug(decodeEntities(inner.replace(/<[^>]*>/g, "")), seen));
    // A heading that contains its own link cannot be wrapped in another anchor.
    const label = inner.includes("<a ") ? inner : `<a href="#${slug}">${inner}</a>`;
    return `<h${level} id="${slug}">${label}</h${level}>`;
  });
}

export function buildCrumbs(rootLabel: string, rel: string): Crumb[] {
  const parts = rel.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: rootLabel, href: "/" }];
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const href = "/" + parts.slice(0, i + 1).map(encodeURIComponent).join("/") + (last ? "" : "/");
    crumbs.push({ label: part, href });
  });
  return crumbs;
}

function pageShell(opts: { title: string; crumbs: Crumb[]; body: string; rawHref?: string }): string {
  const trail = opts.crumbs
    .map((c, i) =>
      `<a href="${escapeHtml(c.href ?? "/")}"${i === opts.crumbs.length - 1 ? ' aria-current="page"' : ""}>${escapeHtml(c.label)}</a>`,
    )
    .join('<span class="sep">/</span>');
  const raw = opts.rawHref ? `<a class="raw" href="${escapeHtml(opts.rawHref)}">raw</a>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header><nav>${trail}${raw}</nav></header>
<main>${opts.body}</main>
</body>
</html>`;
}

export function renderMarkdownPage(opts: { markdown: string; rootLabel: string; rel: string }): string {
  const rawHref = "/" + opts.rel.split("/").map(encodeURIComponent).join("/") + "?raw";
  return pageShell({
    title: basename(opts.rel),
    crumbs: buildCrumbs(opts.rootLabel, opts.rel),
    body: `<article class="markdown">${renderMarkdownHtml(opts.markdown)}</article>`,
    rawHref,
  });
}

export type Entry = { name: string; dir: boolean; size: number; mtime: Date };

export function listEntries(dir: string): Entry[] {
  const entries: Entry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name.startsWith(".")) continue;
    let stat;
    try {
      stat = statSync(join(dir, dirent.name));
    } catch {
      continue; // dangling symlink or a file that vanished mid-listing
    }
    entries.push({ name: dirent.name, dir: stat.isDirectory(), size: stat.size, mtime: stat.mtime });
  }
  entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return entries;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function renderNotFound(opts: { rootLabel: string; path: string }): string {
  const path = opts.path.startsWith("/") ? opts.path : "/" + opts.path;
  const parent = path.slice(0, path.lastIndexOf("/") + 1) || "/";
  return pageShell({
    title: `404 ${path}`,
    crumbs: buildCrumbs(opts.rootLabel, ""),
    body: `<h1>404</h1>
<p><code>${escapeHtml(path)}</code> was not found.</p>
<p><a href="/">&larr; ${escapeHtml(opts.rootLabel)}</a> &middot; <a href="${escapeHtml(parent)}">parent listing</a></p>
<p class="note">Links that go above the served root 404. Serve a higher directory to follow them.</p>`,
  });
}

export function renderListing(opts: {
  rootLabel: string;
  rel: string;
  entries: Entry[];
  readmeHtml?: string;
}): string {
  const rows = opts.entries
    .map((e) => {
      const href = encodeURIComponent(e.name) + (e.dir ? "/" : "");
      const label = escapeHtml(e.name) + (e.dir ? "/" : "");
      const cls = e.dir ? ' class="entry-dir"' : "";
      const size = e.dir ? "" : formatSize(e.size);
      return `<tr><td><a${cls} href="${href}">${label}</a></td><td class="size">${size}</td><td class="mtime">${formatTime(e.mtime)}</td></tr>`;
    })
    .join("\n");

  const body = `<table class="listing">
<thead><tr><th>Name</th><th class="size">Size</th><th class="mtime">Modified</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>${opts.readmeHtml ? `<hr class="split"><article class="markdown">${opts.readmeHtml}</article>` : ""}`;

  return pageShell({
    title: opts.rel ? `${basename(opts.rel)}/` : opts.rootLabel,
    crumbs: buildCrumbs(opts.rootLabel, opts.rel),
    body,
  });
}
