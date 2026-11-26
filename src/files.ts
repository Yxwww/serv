import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** One list has to fit comfortably in a response and in the client's memory. */
export const FILE_LIMIT = 50_000;

/** A root scan is two ripgrep passes; a burst of pages should reuse one. */
const CACHE_TTL_MS = 30_000;
const MAX_CACHED_ROOTS = 50;

export type Entry = { path: string; hidden?: boolean; ignored?: boolean };
export type FileList = { entries: Entry[]; truncated: boolean };

const cache = new Map<string, FileList & { at: number }>();
const inflight = new Map<string, Promise<FileList>>();

/** Every path under the served root, tagged, in one cached scan. */
export function scanFiles(root: string, limit = FILE_LIMIT): Promise<FileList> {
  const key = limit === FILE_LIMIT ? root : `${root}\0${limit}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) {
    return Promise.resolve({ entries: hit.entries, truncated: hit.truncated });
  }
  const pending = inflight.get(key);
  if (pending) return pending;

  const promise = collect(root, limit)
    .then((result) => {
      pruneCache(now);
      cache.set(key, { ...result, at: Date.now() });
      return result;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.at >= CACHE_TTL_MS) cache.delete(key);
  }
  while (cache.size >= MAX_CACHED_ROOTS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Paths below `rel`, rebased so the folder's own contents start at the root. */
export function entriesUnder(scan: FileList, rel: string): FileList {
  if (!rel) return scan;
  const prefix = rel + "/";
  const entries: Entry[] = [];
  for (const entry of scan.entries) {
    if (entry.path.startsWith(prefix) && entry.path.length > prefix.length) {
      entries.push({ ...entry, path: entry.path.slice(prefix.length) });
    }
  }
  // The flag describes this returned subset, not the root scan: a root cap
  // may still have omitted paths below the folder, so it is a lower bound.
  return { entries, truncated: entries.length >= FILE_LIMIT };
}

/** Look up one entry by its root-relative path, with a trailing slash for dirs. */
export function tagMap(scan: FileList): Map<string, Entry> {
  const map = new Map<string, Entry>();
  for (const entry of scan.entries) map.set(entry.path, entry);
  return map;
}

export type Row = { path: string };

type Repo = { git: string; top: string };
const repoCache = new Map<string, Repo | null>();

async function repoFor(root: string): Promise<Repo | null> {
  const git = Bun.which("git");
  if (!git) return null;
  const cached = repoCache.get(root);
  if (cached !== undefined) return cached;

  let repo: Repo | null = null;
  try {
    const proc = Bun.spawn([git, "-C", root, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const top = (await new Response(proc.stdout).text()).trim();
    const code = await proc.exited;
    if (code === 0 && top) repo = { git, top: resolve(top) };
  } catch {
    repo = null;
  }
  repoCache.set(root, repo);
  return repo;
}

function inside(root: string, path: string): boolean {
  const base = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(base);
}

const IGNORE_TIMEOUT_MS = 2_000;

type IgnoreResult =
  | { kind: "ok"; paths: Set<string> }
  | { kind: "failed" }
  | { kind: "timeout" };

/** `check-ignore -v -z` fields are source, line, pattern, pathname, per row. */
async function ignoredRows(repo: Repo, root: string, rows: readonly Row[]): Promise<IgnoreResult> {
  if (rows.length === 0) return { kind: "ok", paths: new Set() };
  const input = rows.map((row) => row.path).join("\0") + "\0";
  const proc = Bun.spawn([repo.git, "-C", root, "check-ignore", "-v", "-z", "--stdin"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // Already gone.
    }
  }, IGNORE_TIMEOUT_MS);

  let text = "";
  let code = 0;
  try {
    const output = new Response(proc.stdout).text();
    try {
      proc.stdin.write(input);
      proc.stdin.end();
    } catch {
      // Git may have exited before reading stdin; the exit code below decides.
    }
    text = await output;
  } finally {
    clearTimeout(timer);
    // Always reap, whether the output read failed or the timer killed git.
    code = await proc.exited;
  }

  // Success even if the timer raced an exit; a killed or failed batch does not.
  if (code !== 0 && code !== 1) return timedOut ? { kind: "timeout" } : { kind: "failed" };

  const ignored = new Set<string>();
  const fields = text.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const source = fields[i]!;
    const pattern = fields[i + 2]!;
    const pathname = fields[i + 3]!;
    if (pattern.startsWith("!")) continue; // a negation re-includes the path
    if (!inside(root, resolve(repo.top, source))) continue;
    ignored.add(pathname);
  }
  return { kind: "ok", paths: ignored };
}

/**
 * A hard `check-ignore` failure (a submodule boundary, for example) must not
 * clear the page. Halve the batch until the failing rows are isolated.
 */
async function ignoredRowsSplit(repo: Repo, root: string, rows: readonly Row[]): Promise<Set<string>> {
  if (rows.length === 0) return new Set();
  const result = await ignoredRows(repo, root, rows);
  if (result.kind === "ok") return result.paths;
  if (result.kind === "timeout" || rows.length === 1) return new Set();

  const mid = rows.length >> 1;
  const [left, right] = await Promise.all([
    ignoredRowsSplit(repo, root, rows.slice(0, mid)),
    ignoredRowsSplit(repo, root, rows.slice(mid)),
  ]);
  for (const path of right) left.add(path);
  return left;
}

/**
 * Tags exactly the rows of the folders being rendered. `check-ignore` runs once
 * per page over those rows, so the 50k `?files` cap cannot hide a tag here.
 * Rules from parents or global excludes do not count. Without git, or outside
 * a repo, there is no ignored tagging; hidden (dot) paths still count.
 */
export async function tagRows(root: string, rows: readonly Row[]): Promise<Map<string, Entry>> {
  const tags = new Map<string, Entry>();
  for (const row of rows) {
    if (isHiddenPath(row.path)) tags.set(row.path, { path: row.path, hidden: true });
  }
  if (rows.length === 0) return tags;

  // Repo tops are real paths; a served root under /var (macOS tmp) is a symlink.
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Keep the given root.
  }
  const repo = await repoFor(realRoot);
  if (!repo) return tags;

  // `check-ignore` fails the whole batch on a path behind a symlink or inside
  // a submodule. Skip those rows and keep the tags for all the real ones.
  const blocked = new Map<string, boolean>();
  const blockedPath = (abs: string): boolean => {
    const hit = blocked.get(abs);
    if (hit !== undefined) return hit;
    let skip = false;
    try {
      const stat = lstatSync(abs);
      if (stat.isSymbolicLink()) skip = true;
      else if (stat.isDirectory()) {
        try {
          // A submodule or worktree root has a .git file, not a directory.
          skip = lstatSync(join(abs, ".git")).isFile();
        } catch {
          // No .git marker here.
        }
      }
    } catch {
      skip = true;
    }
    blocked.set(abs, skip);
    return skip;
  };
  const checkable = rows.filter((row) => {
    let abs = realRoot;
    for (const part of row.path.replace(/\/$/, "").split("/")) {
      abs = join(abs, part);
      if (blockedPath(abs)) return false;
    }
    return true;
  });
  if (checkable.length === 0) return tags;

  const result = await ignoredRows(repo, realRoot, checkable);
  if (result.kind === "timeout") return tags;
  const ignored = result.kind === "ok" ? result.paths : await ignoredRowsSplit(repo, realRoot, checkable);
  for (const path of ignored) {
    const entry = tags.get(path) ?? { path };
    entry.ignored = true;
    tags.set(path, entry);
  }
  return tags;
}

async function collect(root: string, limit: number): Promise<FileList> {
  const rg = Bun.which("rg");
  if (!rg) return fallback(root, limit);

  // Visible first: if it already fills the budget there is nothing to add.
  const visible = await runRg(rg, root, VISIBLE_ARGS, limit);
  if (!visible) return fallback(root, limit);
  if (visible.truncated) return combineFiles(visible.files, [], true, false, limit);

  const all = await runRg(rg, root, ALL_ARGS, limit);
  if (!all) return fallback(root, limit);
  return combineFiles(visible.files, all.files, false, all.truncated, limit);
}

// cwd is always the served root, so `--no-ignore-parent` drops rules above the
// root while the root's own .gitignore and nested ones still apply. `--hidden`
// brings dotfiles in; `.git` stays out. `--no-ignore` is the "everything" pass.
const VISIBLE_ARGS = [
  "--files", "--null", "--hidden",
  "--no-ignore-parent", "--no-ignore-global", "--no-require-git",
  "-g", "!.git",
];
const ALL_ARGS = ["--files", "--null", "--hidden", "--no-ignore", "-g", "!.git"];

/** Which segment is hidden; a file below a dot-directory is hidden too. */
export function isHiddenPath(path: string): boolean {
  const bare = path.endsWith("/") ? path.slice(0, -1) : path;
  for (const part of bare.split("/")) if (part.startsWith(".")) return true;
  return false;
}

/** Merge both passes into tagged entries, non-ignored paths first. Exported for tests. */
export function combineFiles(
  visibleFiles: string[],
  allFiles: string[],
  visibleTruncated: boolean,
  allTruncated: boolean,
  limit: number,
): FileList {
  const visible = new Set(visibleFiles);
  const files = new Set(allFiles);
  for (const file of visibleFiles) files.add(file);

  const dirs = new Map<string, boolean>(); // dir -> has a visible descendant
  const entries = new Map<string, Entry>();
  for (const file of files) {
    const entry: Entry = { path: file };
    if (isHiddenPath(file)) entry.hidden = true;
    if (!visible.has(file)) entry.ignored = true;
    entries.set(file, entry);
    let slash = file.lastIndexOf("/");
    while (slash > 0) {
      const dir = file.slice(0, slash + 1);
      if (visible.has(file)) dirs.set(dir, true);
      else if (!dirs.has(dir)) dirs.set(dir, false);
      slash = file.lastIndexOf("/", slash - 1);
    }
  }
  for (const [dir, hasVisible] of dirs) {
    const entry: Entry = { path: dir };
    if (isHiddenPath(dir)) entry.hidden = true;
    if (!hasVisible) entry.ignored = true;
    entries.set(dir, entry);
  }

  // Fill the cap with real (non-ignored) paths first.
  const list = [...entries.values()];
  list.sort((a, b) => {
    if (!!a.ignored !== !!b.ignored) return a.ignored ? 1 : -1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return {
    entries: list.slice(0, limit),
    truncated: visibleTruncated || allTruncated || list.length > limit,
  };
}

/** Without ripgrep there is no ignore reader, so everything is visible. */
function fallback(root: string, limit: number): FileList {
  const walk = walkFiles(root, limit);
  return combineFiles(walk.files, walk.files, walk.truncated, false, limit);
}

/**
 * Parse NUL-separated paths as they arrive. Once the list is full, ask the
 * caller to stop the producer instead of reading a tree we will only slice.
 */
export async function readFiles(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onCap?: () => void,
): Promise<{ files: string[]; truncated: boolean }> {
  const decoder = new TextDecoder();
  const files: string[] = [];
  let buffer = "";
  let truncated = false;
  const reader = stream.getReader();

  function take(path: string): boolean {
    if (!path) return true;
    if (files.length >= limit) {
      truncated = true;
      onCap?.();
      return false;
    }
    files.push(path);
    return true;
  }

  try {
    while (!truncated) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let start = 0;
      let nul = buffer.indexOf("\0");
      while (nul !== -1) {
        if (!take(buffer.slice(start, nul))) break;
        start = nul + 1;
        nul = buffer.indexOf("\0", start);
      }
      buffer = start ? buffer.slice(start) : buffer;
    }
    buffer += decoder.decode();
    if (!truncated && buffer) take(buffer);
  } finally {
    // Cancelling is also what closes the pipe after an early kill.
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed.
    }
  }
  return { files, truncated };
}

async function runRg(
  rg: string,
  dir: string,
  args: string[],
  limit: number,
): Promise<{ files: string[]; truncated: boolean } | null> {
  let proc;
  try {
    proc = Bun.spawn([rg, ...args], { cwd: dir, stdout: "pipe", stderr: "ignore" });
  } catch {
    return null;
  }
  if (!proc.stdout) {
    kill(proc);
    await proc.exited;
    return null;
  }

  let result;
  try {
    result = await readFiles(proc.stdout, limit, () => kill(proc));
  } catch {
    kill(proc);
    await proc.exited;
    return null;
  }
  const code = await proc.exited;
  // 1 means "no matches", which for --files is an empty directory. A killed
  // process (cap reached) also exits non-zero; its partial list is valid.
  if (!result.truncated && code !== 0 && code !== 1) return null;
  return result;
}

function kill(proc: { kill: () => void }): void {
  try {
    proc.kill();
  } catch {
    // Already gone.
  }
}

/** No ripgrep: walk files only, skipping `.git` and symlinks. */
export function walkFiles(dir: string, limit: number): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  let truncated = false;

  function add(rel: string): void {
    if (files.length >= limit) {
      truncated = true;
      return;
    }
    files.push(rel);
  }

  function walk(abs: string, rel: string): void {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable directory
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name === ".git" || entry.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(abs, entry.name), childRel);
      else add(childRel);
    }
  }

  walk(dir, "");
  return { files, truncated };
}
