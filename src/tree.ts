import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { closeIcon, fileIcon, folderIcon, folderOpenIcon } from "./icons";
import { compareEntries, escapeHtml } from "./render";
import type { Entry as Tagged } from "./files";

/** Per-folder cap: one `node_modules` level must not bloat every page. */
export const MAX_TREE_ENTRIES = 300;

export type TreeEntry = { name: string; dir: boolean };

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

function hrefFor(rel: string, dir: boolean): string {
  const encoded = rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
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

function attrsFor(tags: Map<string, Tagged> | undefined, rel: string, dir: boolean, name: string): string {
  const tag = tags?.get(dir ? rel + "/" : rel);
  let attrs = "";
  if (tag?.hidden || name.startsWith(".")) attrs += " data-hidden";
  if (tag?.ignored) attrs += " data-ignored";
  return attrs;
}

function entryLi(
  dirAbs: string,
  dirRel: string,
  entry: TreeEntry,
  activeRel: string,
  tags?: Map<string, Tagged>,
): string {
  const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
  const attrs = attrsFor(tags, rel, entry.dir, entry.name);
  const href = escapeHtml(hrefFor(rel, entry.dir));
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
    const children = renderLevel(join(dirAbs, entry.name), rel, activeRel, tags);
    return `<li class="d${here ? " current" : ""}"${attrs}><details open data-src="${href}" data-loaded="1"><summary style="--depth:${depth}">${icons}<a href="${href}"${current}>${label}</a></summary>${children}</details></li>`;
  }
  return `<li class="d"${attrs}><details data-src="${href}" data-loaded="0"><summary style="--depth:${depth}">${icons}<a href="${href}">${label}</a></summary><ul></ul></details></li>`;
}

function renderLevel(
  dirAbs: string,
  dirRel: string,
  activeRel: string,
  tags?: Map<string, Tagged>,
): string {
  let entries: TreeEntry[];
  try {
    entries = listTree(dirAbs);
  } catch {
    return "<ul></ul>"; // unreadable directory
  }
  const shown = entries.length > MAX_TREE_ENTRIES ? entries.slice(0, MAX_TREE_ENTRIES) : entries;

  let items = "";
  for (const entry of shown) items += entryLi(dirAbs, dirRel, entry, activeRel, tags);
  if (entries.length > shown.length) {
    const rest = entries.length - shown.length;
    items += `<li class="more"><a href="${escapeHtml(hrefFor(dirRel, true))}" style="--depth:${depthOf(dirRel)}">… ${rest} more</a></li>`;
  }
  return `<ul>${items}</ul>`;
}

/** The whole sidebar, expanded along the current page's path. */
export function renderSidebar(
  rootAbs: string,
  activeRel: string,
  tags?: Map<string, Tagged>,
): string {
  const tree = renderLevel(rootAbs, "", activeRel, tags);
  const rootLabel = basename(rootAbs) || rootAbs;
  return `<aside class="sidebar" id="serv-tree"><div class="sidebar-brand"><a class="brand" href="/" title="Home">serv<span class="brand-dot">.</span></a><span class="brand-root" title="${escapeHtml(rootAbs)}">${escapeHtml(rootLabel)}</span><button type="button" class="nav-close" title="Close file tree" aria-label="Close file tree">${closeIcon()}</button></div><nav class="tree sidebar-scroll" aria-label="Files">${tree}</nav></aside>`;
}

/** Children of one directory, for the lazy `GET /dir/?tree` expansion. */
export function renderTreeFragment(
  dirAbs: string,
  dirRel: string,
  tags?: Map<string, Tagged>,
): string {
  return renderLevel(dirAbs, dirRel, "", tags);
}
