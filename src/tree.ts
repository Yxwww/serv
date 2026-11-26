import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { closeIcon, fileIcon, folderIcon, folderOpenIcon } from "./icons";
import { compareEntries, escapeHtml, tagAttrs } from "./render";
import { rowPath, type Entry as Tag, type Row } from "./files";

/** Per-folder cap: one `node_modules` level must not bloat every page. */
export const MAX_TREE_ENTRIES = 300;

export type TreeEntry = { name: string; dir: boolean };

/** One directory's rows, read once: all entries and the capped ones shown. */
export type TreeLevel = { rel: string; entries: TreeEntry[]; shown: TreeEntry[] };
export type TreeLevels = Map<string, TreeLevel>;

/**
 * One directory per call, never a recursive walk. `withFileTypes` avoids a stat
 * per entry; only symlinks need one, to tell a linked directory from a file.
 * Dotfiles are rows too; the client hides them. `.git` is never shown.
 */
export function listTree(dir: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.name === ".git") continue;
    let isDir = dirent.isDirectory();
    if (!isDir && dirent.isSymbolicLink()) {
      try {
        isDir = statSync(join(dir, dirent.name)).isDirectory();
      } catch {
        continue; // dangling symlink
      }
    }
    entries.push({ name: dirent.name, dir: isDir });
  }
  entries.sort(compareEntries);
  return entries;
}

function hrefFor(path: string): string {
  const dir = path.endsWith("/");
  const bare = dir ? path.slice(0, -1) : path;
  const encoded = bare.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  if (!encoded) return "/";
  return "/" + encoded + (dir ? "/" : "");
}

/**
 * The levels the sidebar opens: the root, then each directory leading to the
 * current entry. A directory page opens its own level; a file page stops at
 * its parent.
 */
export function expandedDirs(activeRel: string, isDir: boolean): string[] {
  const parts = activeRel ? activeRel.split("/").filter(Boolean) : [];
  const upto = isDir ? parts.length : parts.length - 1;
  const dirs = [""];
  for (let i = 1; i <= upto; i++) dirs.push(parts.slice(0, i).join("/"));
  return dirs;
}

/** Indent depth: the number of segments in the parent directory's path. */
function depthOf(dirRel: string): number {
  return dirRel ? dirRel.split("/").filter(Boolean).length : 0;
}

function makeLevel(rel: string, entries: readonly TreeEntry[]): TreeLevel {
  const all = [...entries];
  const shown = all.length > MAX_TREE_ENTRIES ? all.slice(0, MAX_TREE_ENTRIES) : all;
  return { rel, entries: all, shown };
}

function levelFor(dirAbs: string, rel: string): TreeLevel | undefined {
  try {
    return makeLevel(rel, listTree(dirAbs));
  } catch {
    return undefined; // unreadable directory
  }
}

function readLevel(rootAbs: string, rel: string, current?: readonly TreeEntry[]): TreeLevel | undefined {
  if (current) return makeLevel(rel, current);
  return levelFor(rel ? join(rootAbs, rel) : rootAbs, rel);
}

/**
 * Read every expanded level once. A directory listing passes the entries it
 * already read for the current directory, so that one is not walked twice.
 */
export function readTreeLevels(
  rootAbs: string,
  activeRel: string,
  isDir: boolean,
  current?: readonly TreeEntry[],
): TreeLevels {
  const levels: TreeLevels = new Map();
  for (const rel of expandedDirs(activeRel, isDir)) {
    const level = readLevel(rootAbs, rel, current && rel === activeRel ? current : undefined);
    if (level) levels.set(rel, level);
  }
  return levels;
}

/** A single level, for a lazy `?tree` fragment. */
export function readTreeLevel(rootAbs: string, rel: string): TreeLevels {
  const levels: TreeLevels = new Map();
  const level = readLevel(rootAbs, rel);
  if (level) levels.set(rel, level);
  return levels;
}

/** Paths of exactly the rows the sidebar renders, for tagRows. */
export function treeRowPaths(levels: TreeLevels): Row[] {
  const rows: Row[] = [];
  for (const level of levels.values()) {
    for (const entry of level.shown) rows.push({ path: rowPath(level.rel, entry.name, entry.dir) });
  }
  return rows;
}

function entryLi(
  dirRel: string,
  entry: TreeEntry,
  activeRel: string,
  tags: Map<string, Tag> | undefined,
  levels: TreeLevels,
): string {
  const path = rowPath(dirRel, entry.name, entry.dir);
  const rel = entry.dir ? path.slice(0, -1) : path;
  const attrs = tagAttrs(tags?.get(path), entry.name);
  const href = escapeHtml(hrefFor(path));
  const label = escapeHtml(entry.name) + (entry.dir ? "/" : "");
  const depth = depthOf(dirRel);

  if (!entry.dir) {
    const here = rel === activeRel;
    const current = here ? ' aria-current="page"' : "";
    return `<li class="f${here ? " current" : ""}"${attrs} style="--depth:${depth}"><span class="ticon">${fileIcon(entry.name)}</span><a href="${href}"${current}>${label}</a></li>`;
  }

  const here = rel === activeRel;
  const current = here ? ' aria-current="page"' : "";
  const icons = `<span class="ticon ticon-folder">${folderIcon()}</span><span class="ticon ticon-open">${folderOpenIcon()}</span>`;
  // Open only the folders that lead to the current page; the rest load on demand.
  if (here || activeRel.startsWith(rel + "/")) {
    const children = renderLevel(rel, activeRel, tags, levels);
    return `<li class="d${here ? " current" : ""}"${attrs}><details open data-src="${href}" data-loaded="1"><summary style="--depth:${depth}">${icons}<a href="${href}"${current}>${label}</a></summary>${children}</details></li>`;
  }
  return `<li class="d"${attrs}><details data-src="${href}" data-loaded="0"><summary style="--depth:${depth}">${icons}<a href="${href}">${label}</a></summary><ul></ul></details></li>`;
}

function renderLevel(
  dirRel: string,
  activeRel: string,
  tags: Map<string, Tag> | undefined,
  levels: TreeLevels,
): string {
  const level = levels.get(dirRel);
  if (!level) return "<ul></ul>"; // unreadable directory

  let items = "";
  for (const entry of level.shown) items += entryLi(dirRel, entry, activeRel, tags, levels);
  if (level.entries.length > level.shown.length) {
    const rest = level.entries.length - level.shown.length;
    items += `<li class="more"><a href="${escapeHtml(hrefFor(rowPath("", dirRel, true)))}" style="--depth:${depthOf(dirRel)}">… ${rest} more</a></li>`;
  }
  return `<ul>${items}</ul>`;
}

/** The whole sidebar, expanded along the current page's path. */
export function renderSidebar(
  rootAbs: string,
  activeRel: string,
  tags: Map<string, Tag> | undefined,
  levels: TreeLevels,
): string {
  const tree = renderLevel("", activeRel, tags, levels);
  const rootLabel = basename(rootAbs) || rootAbs;
  return `<aside class="sidebar" id="serv-tree"><div class="sidebar-brand"><a class="brand" href="/" title="Home">serv<span class="brand-dot">.</span></a><span class="brand-root" title="${escapeHtml(rootAbs)}">${escapeHtml(rootLabel)}</span><button type="button" class="nav-close" title="Close file tree" aria-label="Close file tree">${closeIcon()}</button></div><nav class="tree sidebar-scroll" aria-label="Files">${tree}</nav></aside>`;
}

/** Children of one directory, for the lazy `GET /dir/?tree` expansion. */
export function renderTreeFragment(
  dirAbs: string,
  dirRel: string,
  tags?: Map<string, Tag>,
  levels?: TreeLevels,
): string {
  if (levels) return renderLevel(dirRel, "", tags, levels);
  const level = levelFor(dirAbs, dirRel);
  const map: TreeLevels = new Map();
  if (level) map.set(dirRel, level);
  return renderLevel(dirRel, "", tags, map);
}
