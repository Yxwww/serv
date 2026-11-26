import { readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileIcon, folderIcon, menuIcon } from "./icons";
import { IMAGE_EXTS } from "./types";
import type { Entry as Tagged } from "./files";
import css from "./styles.css" with { type: "text" };
import searchScript from "./search.bundle.js" with { type: "text" };

/** One default each; the client toggles these and the head script restores them. */
export const SHOW_HIDDEN_DEFAULT = false;
export const SHOW_IGNORED_DEFAULT = false;
const DEFAULT_CLASSES = [
  SHOW_HIDDEN_DEFAULT && "serv-show-hidden",
  SHOW_IGNORED_DEFAULT && "serv-show-ignored",
].filter(Boolean).join(" ");

// Runs in <head>, so rows are already hidden or shown on the first paint.
const PRE_PAINT = `(function(){var e=document.documentElement;e.classList.add("serv-js");try{var h=localStorage.getItem("serv-show-hidden");var i=localStorage.getItem("serv-show-ignored");if(h!==null)e.classList.toggle("serv-show-hidden",h==="1");if(i!==null)e.classList.toggle("serv-show-ignored",i==="1")}catch(_){}})()`;

// Inline so a page never asks the server for an icon. The style element keeps
// the square readable in dark mode when the browser paints a dark tab strip.
const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><style>@media (prefers-color-scheme: dark){rect{fill:#0171e3}}</style><rect width="32" height="32" rx="7" fill="#0064e0"/><text x="16" y="23.5" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="28" font-weight="800" fill="#fff">s</text></svg>`,
);

/** Loads collapsed folders on first open, reveals the active entry, closes the drawer. */
const SCRIPT = `
function titleize(root) {
  var links = (root || document).querySelectorAll(".tree a");
  for (var i = 0; i < links.length; i++) links[i].title = links[i].textContent;
}
document.addEventListener("toggle", function (event) {
  var details = event.target;
  if (!details.open || !details.dataset.src || details.dataset.loaded === "1") return;
  var list = details.querySelector(":scope > ul");
  details.dataset.loaded = "1";
  fetch(details.dataset.src + "?tree")
    .then(function (res) { if (!res.ok) throw new Error(res.status); return res.text(); })
    .then(function (html) { list.outerHTML = html; titleize(details); })
    .catch(function () {
      details.dataset.loaded = "0";
      list.innerHTML = '<li class="more"><span>could not load</span></li>';
    });
}, true);
(function () {
  function reveal() {
    var active = document.querySelector(".tree [aria-current=page]");
    if (active) active.scrollIntoView({ block: "nearest" });
  }
  titleize(document);
  // Measure after the first layout pass; an immediate call lands short.
  requestAnimationFrame(function () { requestAnimationFrame(reveal); });
  window.addEventListener("load", reveal);

  var toggle = document.getElementById("serv-nav-toggle");
  var sidebar = document.getElementById("serv-tree");
  if (!toggle || !sidebar) return;
  var backdrop = document.querySelector(".nav-backdrop");
  var close = sidebar.querySelector(".nav-close");
  var wide = window.matchMedia("(min-width: 800px)");

  function isOpen() { return document.body.classList.contains("nav-open"); }
  function setOpen(open, returnFocus) {
    document.body.classList.toggle("nav-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    sidebar.inert = !open && !wide.matches;
    if (open) {
      requestAnimationFrame(function () {
        if (close) close.focus();
        reveal();
      });
    } else if (returnFocus && !wide.matches) {
      toggle.focus();
    }
  }
  function sync() {
    if (wide.matches) {
      setOpen(false, false);
    } else {
      sidebar.inert = !isOpen();
      toggle.setAttribute("aria-expanded", String(isOpen()));
    }
  }

  toggle.addEventListener("click", function () { setOpen(!isOpen(), true); });
  if (close) close.addEventListener("click", function () { setOpen(false, true); });
  if (backdrop) backdrop.addEventListener("click", function () { setOpen(false, true); });
  wide.addEventListener("change", sync);
  sync();
})();
(function () {
  // One ellipsis beats a row of half-words: keep the ends, drop the middle.
  var bar = document.querySelector(".crumbbar");
  if (!bar) return;
  var crumbs = Array.prototype.slice.call(bar.querySelectorAll(".crumb"));
  var middles = crumbs.slice(1, -1);
  var gap = bar.querySelector(".crumb-gap");
  var seps = Array.prototype.slice.call(bar.querySelectorAll(":scope > .sep"));
  if (!gap || middles.length === 0) return;
  var raf = 0;
  function layout() {
    bar.classList.remove("is-collapsed");
    middles.forEach(function (c) { c.hidden = false; });
    seps.forEach(function (s) { s.hidden = false; });
    var truncated = crumbs.some(function (c) { return c.scrollWidth > c.clientWidth + 1; });
    if (!truncated) return;
    bar.classList.add("is-collapsed");
    middles.forEach(function (c) { c.hidden = true; });
    seps.forEach(function (s, i) { if (i > 0) s.hidden = true; });
  }
  function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); }
  window.addEventListener("resize", schedule);
  layout();
})();
`;

/**
 * Both views are in the page, so a stored preference can replace the grid
 * default without a redirect or another request. The script only flips panels,
 * the toggle state and the toggle links.
 */
const LISTING_SCRIPT = `
(function () {
  var root = document.querySelector("[data-listing-view]");
  if (!root) return;
  var params = null;
  try { params = new URLSearchParams(location.search); } catch (error) {}
  var param = params ? params.get("view") : null;
  var stored = null;
  try { stored = localStorage.getItem("serv-view"); } catch (error) {}
  var view = param === "grid" || param === "list"
    ? param
    : stored === "grid" || stored === "list" ? stored : root.getAttribute("data-view");
  if (param === "grid" || param === "list") {
    try { localStorage.setItem("serv-view", param); } catch (error) {}
  }
  // A bare ?showall is on; ?showall= is not. URLSearchParams cannot tell them apart.
  var bareShowAll = false;
  var query = location.search.replace(/^\\?/, "");
  if (query) {
    var pairs = query.split("&");
    for (var p = 0; p < pairs.length; p++) if (pairs[p] === "showall") bareShowAll = true;
  }
  var showall = params ? params.get("showall") : null;
  var showAllOn = showall === "1" || showall === "true" || (showall === "" && bareShowAll);
  root.setAttribute("data-view", view);
  var panels = root.querySelectorAll("[data-view-panel]");
  for (var i = 0; i < panels.length; i++) {
    panels[i].hidden = panels[i].getAttribute("data-view-panel") !== view;
  }
  var links = root.querySelectorAll("[data-view-link]");
  for (var j = 0; j < links.length; j++) {
    var link = links[j];
    var target = link.getAttribute("data-view-link");
    var active = target === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "true");
    else link.removeAttribute("aria-current");
    if (params) {
      var next = new URLSearchParams(params);
      next.set("view", target);
      if (showAllOn) next.set("showall", "1");
      else next.delete("showall");
      link.href = location.pathname + "?" + next.toString();
    }
  }
})();
`;

const PALETTE = `<div class="palette" id="serv-palette" hidden>
<div class="palette-backdrop" data-palette-close></div>
<div class="palette-panel" role="dialog" aria-modal="true" aria-label="Search files">
<input id="serv-search-input" class="palette-input" type="text" placeholder="Search files…" role="combobox" aria-expanded="false" aria-controls="serv-search-list" aria-autocomplete="list" aria-label="Search files" autocomplete="off" spellcheck="false">
<ul id="serv-search-list" class="palette-list" role="listbox" aria-label="Files"></ul>
<div class="palette-foot"><span id="serv-search-status" class="palette-status" aria-live="polite"></span><span class="palette-keys" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>esc</kbd> close</span></div>
</div>
</div>`;

/** Entries per view before the "show all" link; same ceiling as the tree. */
export const ENTRY_LIMIT = 300;

type View = "list" | "grid";

type Crumb = { label: string; href?: string };

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
function githubSlug(text: string, seen: Set<string>): string {
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
  // Tables scroll inside their own box; a wrapper gives them a rounded border.
  const wrapped = html.replace(/<table>[\s\S]*?<\/table>/g, (t) => `<div class="table-wrap">${t}</div>`);
  const seen = new Set<string>();

  return wrapped.replace(HEADING, (_match, level: string, inner: string) => {
    const slug = escapeHtml(githubSlug(decodeEntities(inner.replace(/<[^>]*>/g, "")), seen));
    // A heading that contains its own link cannot be wrapped in another anchor.
    const label = inner.includes("<a ") ? inner : `<a href="#${slug}">${inner}</a>`;
    return `<h${level} id="${slug}">${label}</h${level}>`;
  });
}

function buildCrumbs(rootLabel: string, rel: string, dir = false): Crumb[] {
  const parts = rel.split("/").filter(Boolean);
  const crumbs: Crumb[] = [{ label: rootLabel, href: "/" }];
  parts.forEach((part, i) => {
    const last = i === parts.length - 1;
    const slash = !last || dir ? "/" : "";
    const href = "/" + parts.slice(0, i + 1).map(encodeURIComponent).join("/") + slash;
    crumbs.push({ label: part, href });
  });
  return crumbs;
}

function pageShell(opts: {
  title: string;
  crumbs: Crumb[];
  body: string;
  rawHref?: string;
  rawBlank?: boolean;
  sidebar?: string;
  bodyScript?: string;
}): string {
  let trail = "";
  opts.crumbs.forEach((c, i) => {
    const last = i === opts.crumbs.length - 1;
    const cls = i === 0 ? "crumb" : last ? "crumb last" : "crumb mid";
    if (i > 0) trail += '<span class="sep">/</span>';
    if (i === 1) trail += '<span class="crumb-gap">…<span class="sep">/</span></span>';
    trail += `<a class="${cls}" href="${escapeHtml(c.href ?? "/")}" title="${escapeHtml(c.label)}"${last ? ' aria-current="page"' : ""}>${escapeHtml(c.label)}</a>`;
  });
  const raw = opts.rawHref
    ? `<a class="raw" href="${escapeHtml(opts.rawHref)}"${opts.rawBlank ? ' target="_blank" rel="noopener"' : ""}>${opts.rawBlank ? "raw ↗" : "raw"}</a>`
    : "";
  const menu = opts.sidebar
    ? `<button type="button" id="serv-nav-toggle" class="nav-btn" title="Toggle file tree" aria-label="Toggle file tree" aria-controls="serv-tree" aria-expanded="false">${menuIcon()}</button>`
    : "";
  const backdrop = opts.sidebar
    ? `<div class="nav-backdrop" aria-hidden="true"></div>`
    : "";
  const sidebar = opts.sidebar ?? "";
  const script = opts.sidebar ? `<script>${SCRIPT}</script>` : "";
  const bodyScript = opts.bodyScript ? `<script>${opts.bodyScript}</script>` : "";
  const fullPath = "/" + opts.crumbs.slice(1).map((c) => c.label).join("/");
  return `<!doctype html>
<html lang="en"${DEFAULT_CLASSES ? ` class="${DEFAULT_CLASSES}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON}">
<script>${PRE_PAINT}</script>
<style>${css}</style>
${opts.sidebar ? `<noscript><style>@media (max-width: 799.98px) {
  .sidebar { position: static; inset: auto; width: auto; max-height: 50dvh; transform: none; visibility: visible; border-right: 0; border-bottom: 1px solid var(--color-border); }
  .nav-btn, .nav-close, .nav-backdrop { display: none; }
}</style></noscript>` : ""}
</head>
<body class="min-h-dvh bg-body text-primary">
<div class="app">
${sidebar}
<div class="flex min-h-dvh min-w-0 flex-col">
<header class="sticky top-0 z-20 flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-border bg-body/85 px-6 backdrop-blur md:px-10 xl:px-12">
${menu}
<nav class="crumbbar flex-1" title="${escapeHtml(fullPath)}">${trail}</nav>
${raw}
</header>
<main class="w-full px-6 py-8 md:px-10 md:py-10 xl:px-12">${opts.body}</main>
</div>
</div>
${backdrop}
${PALETTE}
${script}${bodyScript}<script type="module">${searchScript}</script>
</body>
</html>`;
}

function rawHrefFor(rel: string): string {
  return "/" + rel.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "?raw";
}

export function renderMarkdownPage(opts: {
  markdown: string;
  rootLabel: string;
  rel: string;
  sidebar?: string;
  truncated?: number; // shown bytes; omitted when the whole file fits
}): string {
  const rawHref = rawHrefFor(opts.rel);
  return pageShell({
    title: basename(opts.rel),
    crumbs: buildCrumbs(opts.rootLabel, opts.rel),
    body: `${opts.truncated ? truncationNotice(opts.truncated, rawHref) : ""}<article class="markdown prose max-w-none">${renderMarkdownHtml(opts.markdown)}</article>`,
    rawHref,
    sidebar: opts.sidebar,
  });
}

function truncationNotice(bytes: number, href: string): string {
  return `<p class="notice">Showing the first ${formatSize(bytes)} of this file. <a href="${escapeHtml(href)}">Open the full file</a>.</p>`;
}

/** Line-numbered source view for text files and pretty-printed JSON. */
export function renderSourcePage(opts: {
  text: string;
  rootLabel: string;
  rel: string;
  sidebar?: string;
  truncated?: number; // shown bytes; omitted when the whole file fits
  rawBlank?: boolean;
}): string {
  const code = opts.text.endsWith("\n") ? opts.text.slice(0, -1) : opts.text;
  const lineCount = code === "" ? 1 : code.split("\n").length;
  let gutter = "1";
  for (let n = 2; n <= lineCount; n++) gutter += "\n" + n;
  const rawHref = rawHrefFor(opts.rel);
  const notice = opts.truncated ? truncationNotice(opts.truncated, rawHref) : "";
  return pageShell({
    title: basename(opts.rel),
    crumbs: buildCrumbs(opts.rootLabel, opts.rel),
    body: `${notice}<div class="source"><pre class="gutter" aria-hidden="true">${gutter}</pre><pre class="code"><code>${escapeHtml(code)}</code></pre></div>`,
    rawHref,
    rawBlank: opts.rawBlank,
    sidebar: opts.sidebar,
  });
}

type Entry = { name: string; dir: boolean; size: number; mtime: Date };

/** Folders first, then files, each by name. Shared by listings and the sidebar. */
export function compareEntries(a: { name: string; dir: boolean }, b: { name: string; dir: boolean }): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function listEntries(dir: string): Entry[] {
  const entries: Entry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === ".git") continue;
    let stat;
    try {
      stat = statSync(join(dir, dirent.name));
    } catch {
      continue; // dangling symlink or a file that vanished mid-listing
    }
    entries.push({ name: dirent.name, dir: stat.isDirectory(), size: stat.size, mtime: stat.mtime });
  }
  entries.sort(compareEntries);
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

export function renderNotFound(opts: { rootLabel: string; path: string; sidebar?: string }): string {
  const path = opts.path.startsWith("/") ? opts.path : "/" + opts.path;
  const parent = parentHref(path);
  return pageShell({
    title: `404 ${path}`,
    crumbs: buildCrumbs(opts.rootLabel, ""),
    body: `<div class="not-found">
<p class="not-found-code">404</p>
<h1 class="not-found-title">Page not found</h1>
<p><code>${escapeHtml(path)}</code> was not found.</p>
<p><a href="/">&larr; ${escapeHtml(opts.rootLabel)}</a> &middot; <a href="${escapeHtml(parent)}">parent listing</a></p>
<p class="note">If this came from a relative link that goes above the served folder, serve a higher directory.</p>
</div>`,
    sidebar: opts.sidebar,
  });
}

/** The listing that contains this path, even when the path names a directory. */
function parentHref(path: string): string {
  const absolute = path.startsWith("/") ? path : "/" + path;
  const trimmed = absolute.length > 1 ? absolute.replace(/\/+$/, "") : absolute;
  const parentPath = trimmed.slice(0, trimmed.lastIndexOf("/") + 1) || "/";
  return parentPath === "/"
    ? "/"
    : "/" + parentPath.split("/").filter(Boolean).map(encodeURIComponent).join("/") + "/";
}

export function renderError(opts: {
  rootLabel: string;
  path: string;
  sidebar?: string;
  status: 403 | 500;
  message: string;
}): string {
  const parent = parentHref(opts.path);
  return pageShell({
    title: `${opts.status} ${opts.path}`,
    crumbs: buildCrumbs(opts.rootLabel, ""),
    body: `<div class="not-found">
<p class="not-found-code">${opts.status}</p>
<h1 class="not-found-title">${escapeHtml(opts.message)}</h1>
<p><code>${escapeHtml(opts.path)}</code> could not be served.</p>
<p><a href="/">&larr; ${escapeHtml(opts.rootLabel)}</a> &middot; <a href="${escapeHtml(parent)}">parent listing</a></p>
</div>`,
    sidebar: opts.sidebar,
  });
}

function viewHref(view: View, showAll: boolean): string {
  return `?view=${view}${showAll ? "&amp;showall=1" : ""}`;
}

function viewToggle(active: View, showAll: boolean): string {
  const option = (view: View) => {
    const on = view === active;
    return `<a class="view-option${on ? " is-active" : ""}" data-view-link="${view}" href="${viewHref(view, showAll)}"${on ? ' aria-current="true"' : ""}>${view === "list" ? "List" : "Grid"}</a>`;
  };
  return `<div class="view-toggle" role="group" aria-label="View as">${option("list")}${option("grid")}</div>`;
}

function rowAttrs(tag: Tagged | undefined): string {
  let attrs = "";
  if (tag?.hidden) attrs += " data-hidden";
  if (tag?.ignored) attrs += " data-ignored";
  return attrs;
}

function gridCard(entry: Entry, tag: Tagged | undefined): string {
  const href = encodeURIComponent(entry.name) + (entry.dir ? "/" : "");
  const name = escapeHtml(entry.name);
  const label = name + (entry.dir ? "/" : "");
  let thumb: string;
  if (entry.dir) {
    thumb = `<span class="grid-thumb grid-thumb-folder">${folderIcon()}</span>`;
  } else if (IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
    thumb = `<span class="grid-thumb grid-thumb-image"><img src="${href}" alt="" loading="lazy" decoding="async"></span>`;
  } else {
    thumb = `<span class="grid-thumb">${fileIcon(entry.name)}</span>`;
  }
  const sub = entry.dir ? "Folder" : `${formatSize(entry.size)} &middot; ${formatTime(entry.mtime)}`;
  return `<li${rowAttrs(tag)}><a class="grid-card" href="${href}" title="${name}">${thumb}<span class="grid-meta"><span class="grid-name" title="${name}">${label}</span><span class="grid-sub">${sub}</span></span></a></li>`;
}

function hiddenIndicator(count: number): string {
  const label = count === 1 ? "entry" : "entries";
  return `<button type="button" class="hidden-count" data-serv-hidden-count aria-label="Show ${count} hidden ${label}" title="Shift+H dotfiles · Shift+I ignored"${count ? "" : " hidden"}>${count} hidden</button>`;
}

export function renderListing(opts: {
  rootLabel: string;
  rel: string;
  entries: Entry[];
  tags?: Map<string, Tagged>;
  readmeHtml?: string;
  readmeTruncated?: number;
  sidebar?: string;
  view?: View;
  showAll?: boolean;
}): string {
  const activeView: View = opts.view ?? "grid";
  const showAll = opts.showAll === true;
  const readmeHref = rawHrefFor(opts.rel ? `${opts.rel}/README.md` : "README.md");
  const tagFor = (entry: Entry): Tagged | undefined => {
    const path = (opts.rel ? `${opts.rel}/` : "") + entry.name + (entry.dir ? "/" : "");
    const tag = opts.tags?.get(path);
    if (tag) return tag;
    // Without a scan, a dot-name is still a hidden row.
    return entry.name.startsWith(".") ? { path, hidden: true } : undefined;
  };

  const shown = showAll ? opts.entries : opts.entries.slice(0, ENTRY_LIMIT);
  // One entry per row; a dotfile that is also ignored counts once.
  let hiddenCount = 0;
  for (const entry of shown) {
    const tag = tagFor(entry);
    const hidden = (tag?.hidden && !SHOW_HIDDEN_DEFAULT) || (tag?.ignored && !SHOW_IGNORED_DEFAULT);
    if (hidden) hiddenCount++;
  }
  const indicator = hiddenIndicator(hiddenCount);
  const rows = shown
    .map((e) => {
      const href = encodeURIComponent(e.name) + (e.dir ? "/" : "");
      const label = escapeHtml(e.name) + (e.dir ? "/" : "");
      const cls = e.dir ? ' class="entry-dir"' : "";
      const size = e.dir ? "" : formatSize(e.size);
      const icon = e.dir ? folderIcon() : fileIcon(e.name);
      return `<tr${rowAttrs(tagFor(e))}><td class="name"><span class="ticon">${icon}</span><a${cls} href="${href}" title="${escapeHtml(e.name)}">${label}</a></td><td class="size">${size}</td><td class="mtime">${formatTime(e.mtime)}</td></tr>`;
    })
    .join("\n");

  const table = `<table class="listing">
<thead><tr><th>Name</th><th class="size">Size</th><th class="mtime">Modified</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>`;
  const cards = shown.map((entry) => gridCard(entry, tagFor(entry))).join("\n");
  const more = (view: View) =>
    !showAll && shown.length < opts.entries.length
      ? `<p class="listing-more-wrap"><a class="listing-more" href="?view=${view}&amp;showall=1">Show all ${opts.entries.length}</a></p>`
      : "";
  const grid = `<ul class="file-grid" role="list">
${cards}
</ul>${more("grid")}`;
  const list = `${table}${more("list")}`;

  const filesHead = `<div class="panel-head"><h2 class="panel-title">Files <span class="panel-count">${opts.entries.length}</span></h2><div class="panel-tools">${indicator}${viewToggle(activeView, showAll)}</div></div>`;
  const filesPanel = `<section class="files-panel${opts.readmeHtml ? "" : " files-panel-full"}" data-listing-view data-view="${activeView}">${filesHead}<div class="listing-views">
<div class="listing-view" data-view-panel="list"${activeView === "grid" ? " hidden" : ""}>${list}</div>
<div class="listing-view" data-view-panel="grid"${activeView === "list" ? " hidden" : ""}>${grid}</div>
</div></section>`;

  let body: string;
  if (opts.entries.length === 0) {
    body = `<p class="empty-state">This folder is empty.</p>`;
  } else if (opts.readmeHtml) {
    const notice = opts.readmeTruncated ? truncationNotice(opts.readmeTruncated, readmeHref) : "";
    body = `<div class="listing-split"><div class="listing-panels">
<section class="readme-panel"><div class="panel-head"><h2 class="panel-title">README.md</h2><a class="panel-raw" href="${escapeHtml(readmeHref)}">raw</a></div>${notice}<article class="markdown prose max-w-none">${opts.readmeHtml}</article></section>
${filesPanel}
</div></div>`;
  } else {
    body = filesPanel;
  }

  return pageShell({
    title: opts.rel ? `${basename(opts.rel)}/` : opts.rootLabel,
    crumbs: buildCrumbs(opts.rootLabel, opts.rel, true),
    body,
    sidebar: opts.sidebar,
    bodyScript: opts.entries.length ? LISTING_SCRIPT : undefined,
  });
}

type ViewerBase = { rootLabel: string; rel: string; sidebar?: string };

function viewerPage(opts: ViewerBase & { body: string; bodyScript?: string }): string {
  return pageShell({
    title: basename(opts.rel),
    crumbs: buildCrumbs(opts.rootLabel, opts.rel),
    body: opts.body,
    rawHref: rawHrefFor(opts.rel),
    rawBlank: true,
    sidebar: opts.sidebar,
    bodyScript: opts.bodyScript,
  });
}

export type ImageLink = { name: string; href: string };

export function renderImageViewer(opts: ViewerBase & {
  size: number;
  position?: { index: number; total: number };
  prev?: ImageLink;
  next?: ImageLink;
}): string {
  const raw = escapeHtml(rawHrefFor(opts.rel));
  const name = escapeHtml(basename(opts.rel));
  const step = (direction: "prev" | "next", label: string, link?: ImageLink) => {
    const text = direction === "prev" ? `← ${label}` : `${label} →`;
    if (!link) return `<span class="image-step is-disabled" aria-disabled="true">${text}</span>`;
    return `<a class="image-step" rel="${direction}" href="${escapeHtml(link.href)}" aria-label="${label} image: ${escapeHtml(link.name)}">${text}</a>`;
  };
  const nav = opts.position
    ? `<nav class="image-nav" aria-label="Images in this folder">${step("prev", "Previous", opts.prev)}<span class="image-position">${opts.position.index} / ${opts.position.total}</span>${step("next", "Next", opts.next)}</nav>`
    : "";
  return viewerPage({
    rootLabel: opts.rootLabel,
    rel: opts.rel,
    sidebar: opts.sidebar,
    body: `<figure class="image-viewer"><a class="image-link" href="${raw}" target="_blank" rel="noopener"><img id="serv-viewer-img" src="${raw}" alt="${name}"></a><figcaption><span id="serv-viewer-dims"></span><span class="dot">·</span>${formatSize(opts.size)}</figcaption></figure>${nav}`,
    bodyScript: `(function () {
  var img = document.getElementById("serv-viewer-img");
  function show() {
    if (!img.naturalWidth) return;
    document.getElementById("serv-viewer-dims").textContent = img.naturalWidth + " × " + img.naturalHeight + " px";
  }
  if (img.complete) show();
  img.addEventListener("load", show);
})();`,
  });
}

export function renderFrameViewer(opts: ViewerBase & { src: string }): string {
  const src = escapeHtml(opts.src);
  const title = escapeHtml(basename(opts.rel));
  return viewerPage({
    rootLabel: opts.rootLabel,
    rel: opts.rel,
    sidebar: opts.sidebar,
    body: `<iframe class="viewer-frame" src="${src}" title="${title}"></iframe>`,
  });
}

export function renderMediaViewer(opts: ViewerBase & { kind: "video" | "audio" }): string {
  const src = escapeHtml(rawHrefFor(opts.rel));
  const tag = opts.kind;
  return viewerPage({
    rootLabel: opts.rootLabel,
    rel: opts.rel,
    sidebar: opts.sidebar,
    body: `<${tag} class="viewer-media" controls src="${src}"></${tag}>`,
  });
}

export function renderBinaryViewer(opts: ViewerBase & { size: number; type: string }): string {
  const raw = escapeHtml(rawHrefFor(opts.rel));
  return viewerPage({
    rootLabel: opts.rootLabel,
    rel: opts.rel,
    sidebar: opts.sidebar,
    body: `<div class="file-card"><div class="file-card-name">${escapeHtml(basename(opts.rel))}</div><p>${escapeHtml(opts.type)}</p><p>${formatSize(opts.size)}</p><a class="button" href="${raw}" target="_blank" rel="noopener" download>Open raw / download</a></div>`,
  });
}
