import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import {
  AUDIO_EXTS,
  CODE_EXTS,
  HTML_EXTS,
  IMAGE_EXTS,
  JS_EXTS,
  JSON_EXTS,
  VIDEO_EXTS,
  isMarkdown,
  isText,
  isTextName,
} from "./types";
import { highlightSource } from "./highlight";
import {
  listEntries,
  renderBinaryViewer,
  renderError,
  renderFrameViewer,
  renderImageViewer,
  renderListing,
  renderMarkdownHtml,
  renderMarkdownPage,
  renderMediaViewer,
  renderNotFound,
  renderSourcePage,
  shownEntries,
  type ImageLink,
} from "./render";
import {
  readTreeLevel,
  readTreeLevels,
  renderSidebar,
  renderTreeFragment,
  treeRowPaths,
  type TreeEntry,
  type TreeLevels,
} from "./tree";
import { entriesUnder, rowPath, scanFiles, tagRows, type Entry as Tag, type Row } from "./files";

type Input = { kind: "dir" | "file"; root: string; startPath: string };

/** A file argument serves its parent, so relative links and images keep resolving. */
export function resolveInput(inputPath: string, base = process.cwd()): Input {
  const abs = resolve(base, inputPath);
  const stat = statSync(abs);
  if (stat.isDirectory()) return { kind: "dir", root: abs, startPath: "/" };
  return {
    kind: "file",
    root: dirname(abs),
    startPath: "/" + encodeURIComponent(basename(abs)),
  };
}

type Resolved =
  | { kind: "outside" }
  | { kind: "missing" }
  | { kind: "file"; path: string; rel: string }
  | { kind: "dir"; path: string; rel: string };

/** Lexical containment check: decode first, so %2e%2e cannot slip past the `..` test. */
export function resolveRequest(root: string, urlPath: string): Resolved {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { kind: "outside" };
  }
  if (decoded.includes("\0")) return { kind: "outside" };

  const parts = decoded.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.includes("..")) return { kind: "outside" };

  const target = resolve(root, ...parts);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (target !== root && !target.startsWith(prefix)) return { kind: "outside" };

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { kind: "missing" };
  }
  const rel = parts.join("/");
  return stat.isDirectory() ? { kind: "dir", path: target, rel } : { kind: "file", path: target, rel };
}

export const SOURCE_LIMIT = 1024 * 1024;
const VARY_DEST = { vary: "Sec-Fetch-Dest" };

/** Drop a UTF-8 sequence cut by the byte cap instead of decoding it as U+FFFD. */
function charBoundary(buf: Buffer, n: number): number {
  let lead = n - 1;
  while (lead >= 0 && (buf[lead]! & 0xc0) === 0x80) lead--;
  if (lead < 0) return n;
  const byte = buf[lead]!;
  const need = byte < 0x80 ? 1 : (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
  return lead + need <= n ? n : lead;
}

/** Read at most SOURCE_LIMIT bytes, so a huge source file never lands in memory whole. */
function readHead(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(SOURCE_LIMIT);
    const n = readSync(fd, buf, 0, SOURCE_LIMIT, 0);
    return buf.toString("utf8", 0, n === SOURCE_LIMIT ? charBoundary(buf, n) : n);
  } finally {
    closeSync(fd);
  }
}

async function readText(path: string): Promise<{ text: string; truncated: boolean }> {
  if (statSync(path).size > SOURCE_LIMIT) return { text: readHead(path), truncated: true };
  return { text: await Bun.file(path).text(), truncated: false };
}

type RequestHeaders = Headers | Record<string, string | undefined>;

/** Case-insensitive read that works for a real Headers object and a test object. */
function headerValue(headers: RequestHeaders | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value ?? undefined;
  }
  return undefined;
}

function fileHref(rel: string): string {
  return "/" + rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function looksText(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * The type of the file's own bytes. Text is served as its real type when a
 * browser asks for a subresource (CSS, JS) and as plain text otherwise; Bun's
 * .ts -> video/mp2t mapping is not useful in a tab.
 */
function rawTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (isMarkdown(ext)) return "text/markdown; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (JS_EXTS.has(ext)) return "text/javascript; charset=utf-8";
  if (isText(ext) || isTextName(basename(path))) return "text/plain; charset=utf-8";
  if (!ext) return looksText(path) ? "text/plain; charset=utf-8" : "application/octet-stream";
  return Bun.file(path).type || "application/octet-stream";
}

function isTextFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return isText(ext) || isTextName(basename(path)) || (ext === "" && looksText(path));
}

/** Opening here turns an unreadable file into a response we can dress up. */
function assertReadable(path: string): number {
  const fd = openSync(path, "r");
  try {
    return fstatSync(fd).size;
  } finally {
    closeSync(fd);
  }
}

type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

/** One range only; a malformed or multi-range header falls back to the full file. */
function parseByteRange(value: string | undefined, size: number): ByteRange {
  if (!value) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match) return { kind: "full" };
  const startText = match[1]!;
  const endText = match[2]!;
  if (startText === "" && endText === "") return { kind: "full" };

  if (startText === "") {
    const suffix = Number(endText);
    if (suffix <= 0 || size === 0) return { kind: "unsatisfiable" };
    return { kind: "partial", start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(startText);
  if (start >= size) return { kind: "unsatisfiable" };
  if (endText === "") return { kind: "partial", start, end: size - 1 };
  const end = Number(endText);
  if (end < start) return { kind: "full" };
  return { kind: "partial", start, end: Math.min(end, size - 1) };
}

function fileResponse(
  path: string,
  type = rawTypeFor(path),
  headers: Record<string, string> = {},
  range?: string,
): Response {
  const size = assertReadable(path);
  const parsed = parseByteRange(range, size);
  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: {
        "content-type": type,
        "content-length": "0",
        "accept-ranges": "bytes",
        "content-range": `bytes */${size}`,
        ...headers,
      },
    });
  }
  if (parsed.kind === "partial") {
    return new Response(Bun.file(path).slice(parsed.start, parsed.end + 1), {
      status: 206,
      headers: {
        "content-type": type,
        "content-length": String(parsed.end - parsed.start + 1),
        "accept-ranges": "bytes",
        "content-range": `bytes ${parsed.start}-${parsed.end}/${size}`,
        ...headers,
      },
    });
  }
  return new Response(Bun.file(path), {
    headers: {
      "content-type": type,
      "content-length": String(size),
      "accept-ranges": "bytes",
      ...headers,
    },
  });
}

function htmlResponse(html: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "content-length": String(Buffer.byteLength(html)), ...headers },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(Buffer.byteLength(body)) },
  });
}

function jsonResponse(body: unknown): Response {
  const text = JSON.stringify(body);
  return new Response(text, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(text)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function failureStatus(error: unknown): 403 | 500 {
  const code = (error as { code?: string }).code;
  return code === "EACCES" || code === "EPERM" ? 403 : 500;
}

type ImageNav = {
  position?: { index: number; total: number };
  prev?: ImageLink;
  next?: ImageLink;
};

/** Previous/next image in listing order, from one read of the containing folder. */
function imageNeighbors(path: string, rel: string): ImageNav {
  const dir = dirname(path);
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => IMAGE_EXTS.has(extname(entry.name).toLowerCase()))
    .filter((entry) => {
      if (!entry.isSymbolicLink()) return !entry.isDirectory();
      // A symlink's Dirent says link, not what it points at. Only image-named
      // links pay for the stat, and a link to a folder is not a neighbour.
      try {
        return !statSync(join(dir, entry.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((entry) => entry.name)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const index = names.indexOf(basename(path));
  if (index < 0) return {};
  const prefix = rel.slice(0, rel.lastIndexOf("/") + 1);
  const link = (name: string): ImageLink => ({ name, href: fileHref(prefix + name) });
  return {
    position: { index: index + 1, total: names.length },
    prev: index > 0 ? link(names[index - 1]!) : undefined,
    next: index < names.length - 1 ? link(names[index + 1]!) : undefined,
  };
}

function showAllEnabled(url: URL): boolean {
  const value = url.searchParams.get("showall");
  if (value === "1" || value === "true") return true;
  if (value !== "") return false;
  // Only a parameter with no "=" at all is the bare form; ?showall= stays off.
  const query = url.search.slice(1);
  return query !== "" && query.split("&").includes("showall");
}

/** Tag exactly the rendered rows; a failure here must lose tags, not levels. */
async function tagLevels(
  root: string,
  levels: TreeLevels,
  extra: readonly Row[] = [],
): Promise<Map<string, Tag>> {
  return tagRows(root, [...treeRowPaths(levels), ...extra]);
}

/**
 * The levels a page shows plus tags for exactly those rows: the sidebar, and
 * any listing rows that are not already a tree level.
 */
async function pageTree(
  root: string,
  rel: string,
  isDir: boolean,
  current?: readonly TreeEntry[],
  extra: readonly Row[] = [],
): Promise<{ levels: TreeLevels; tags: Map<string, Tag> }> {
  const levels = readTreeLevels(root, rel, isDir, current);
  const tags = await tagLevels(root, levels, extra);
  return { levels, tags };
}

async function sidebarFor(root: string, rel: string, isDir: boolean): Promise<string> {
  const { levels, tags } = await pageTree(root, rel, isDir);
  return renderSidebar(root, rel, tags, levels);
}

async function route(
  root: string,
  requestUrl: string,
  headers?: RequestHeaders,
): Promise<Response> {
  const url = new URL(requestUrl, "http://127.0.0.1");
  if (url.pathname === "/favicon.ico" && !isFile(join(root, "favicon.ico"))) {
    return new Response(null, { status: 204 });
  }
  const target = resolveRequest(root, url.pathname);
  const rootLabel = basename(root) || root;
  const raw = url.searchParams.has("raw");
  const range = headerValue(headers, "range");
  const serveFile = (path: string, type?: string, extra: Record<string, string> = {}) =>
    fileResponse(path, type, extra, range);

  if (target.kind === "outside") return textResponse("Forbidden\n", 403);

  if (target.kind === "missing") {
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the encoded form rather than failing the 404 page.
    }
    return htmlResponse(renderNotFound({ rootLabel, path, sidebar: await sidebarFor(root, "", true) }), 404);
  }

  const dest = headerValue(headers, "sec-fetch-dest");
  const ext = extname(target.path).toLowerCase();

  try {
    if (target.kind === "dir") {
      // A trailing slash makes relative links on the page resolve inside the directory.
      if (!url.pathname.endsWith("/")) {
        return new Response(null, {
          status: 308,
          headers: { location: url.pathname + "/" + url.search, "content-length": "0" },
        });
      }
      if (url.searchParams.has("files")) {
        return jsonResponse(entriesUnder(await scanFiles(root), target.rel));
      }
      if (url.searchParams.has("tree")) {
        const levels = readTreeLevel(root, target.rel);
        const tags = await tagRows(root, treeRowPaths(levels));
        return htmlResponse(renderTreeFragment(target.rel, tags, levels));
      }

      const indexFile = isFile(join(target.path, "index.html"));
      const readme = join(target.path, "README.md");
      const readmeFile = isFile(readme);
      const readmeText = readmeFile ? await readText(readme) : undefined;
      const requested = url.searchParams.get("view");
      const view = requested === "list" || requested === "grid" ? requested : undefined;
      const showAll = showAllEnabled(url);
      const entries = listEntries(target.path);
      // Reuse the listing's read for the current sidebar level, and tag the
      // sidebar rows plus exactly the listing rows this page shows.
      const extra = shownEntries(entries, showAll).map((entry) => ({
        path: rowPath(target.rel, entry.name, entry.dir),
      }));
      const { levels, tags } = await pageTree(root, target.rel, true, entries, extra);
      return htmlResponse(
        renderListing({
          rootLabel,
          rel: target.rel,
          entries,
          hasIndexHtml: indexFile,
          readmeHtml: readmeText ? renderMarkdownHtml(readmeText.text) : undefined,
          readmeTruncated: readmeText?.truncated ? SOURCE_LIMIT : undefined,
          sidebar: renderSidebar(root, target.rel, tags, levels),
          tags,
          view,
          showAll,
        }),
      );
    }

    // A subresource request gets the file's own bytes, whatever the type.
    if (!raw && dest !== undefined && dest !== "document") {
      return serveFile(target.path, rawTypeFor(target.path), VARY_DEST);
    }

    if (isMarkdown(ext)) {
      if (raw) return serveFile(target.path, "text/plain; charset=utf-8");
      const { text, truncated } = await readText(target.path);
      const requested = url.searchParams.get("view");
      const view = requested === "source" || requested === "rendered" ? requested : undefined;
      return htmlResponse(
        renderMarkdownPage({
          markdown: text,
          rootLabel,
          rel: target.rel,
          sidebar: await sidebarFor(root, target.rel, false),
          truncated: truncated ? SOURCE_LIMIT : undefined,
          view,
        }),
        200,
        VARY_DEST,
      );
    }

    if (isTextFile(target.path)) {
      if (raw) return serveFile(target.path, "text/plain; charset=utf-8");
      const { text, truncated } = await readText(target.path);
      const codeHtml = CODE_EXTS.has(ext) ? await highlightSource(text, ext) : undefined;
      return htmlResponse(
        renderSourcePage({
          text,
          rootLabel,
          rel: target.rel,
          sidebar: await sidebarFor(root, target.rel, false),
          truncated: truncated ? SOURCE_LIMIT : undefined,
          codeHtml,
        }),
        200,
        VARY_DEST,
      );
    }

    if (raw) return serveFile(target.path, rawTypeFor(target.path), VARY_DEST);
    if (dest !== "document") return serveFile(target.path, rawTypeFor(target.path), VARY_DEST);

    // A viewer for a file nobody can read is worse than an error page.
    assertReadable(target.path);

    const sidebar = await sidebarFor(root, target.rel, false);
    const size = statSync(target.path).size;
    let page: string;

    if (JSON_EXTS.has(ext)) {
      let truncated = size > SOURCE_LIMIT;
      let code = truncated ? readHead(target.path) : await Bun.file(target.path).text();
      let parseFailed = false;
      if (!truncated) {
        try {
          code = JSON.stringify(JSON.parse(code), null, 2);
        } catch {
          // Not valid JSON: show the text as-is, without JSON token colors.
          parseFailed = true;
        }
      }
      if (code.length > SOURCE_LIMIT) {
        code = code.slice(0, SOURCE_LIMIT);
        truncated = true;
      }
      page = renderSourcePage({
        text: code,
        rootLabel,
        rel: target.rel,
        sidebar,
        truncated: truncated ? SOURCE_LIMIT : undefined,
        rawBlank: true,
        codeHtml: parseFailed ? undefined : await highlightSource(code, ext),
      });
    } else if (IMAGE_EXTS.has(ext)) {
      let nav: ImageNav = {};
      try {
        nav = imageNeighbors(target.path, target.rel);
      } catch {
        // A readable image in an unlistable folder still gets its viewer.
      }
      page = renderImageViewer({ rootLabel, rel: target.rel, sidebar, size, ...nav });
    } else if (ext === ".pdf") {
      page = renderFrameViewer({ rootLabel, rel: target.rel, sidebar, src: fileHref(target.rel) + "?raw" });
    } else if (VIDEO_EXTS.has(ext)) {
      page = renderMediaViewer({ kind: "video", rootLabel, rel: target.rel, sidebar });
    } else if (AUDIO_EXTS.has(ext)) {
      page = renderMediaViewer({ kind: "audio", rootLabel, rel: target.rel, sidebar });
    } else if (HTML_EXTS.has(ext)) {
      page = renderFrameViewer({ rootLabel, rel: target.rel, sidebar, src: fileHref(target.rel) });
    } else {
      page = renderBinaryViewer({ rootLabel, rel: target.rel, sidebar, size, type: rawTypeFor(target.path) });
    }

    return htmlResponse(page, 200, VARY_DEST);
  } catch (error) {
    const status = failureStatus(error);
    if (status === 500) console.error(`serv: could not read ${target.path}`, error);
    const path = target.kind === "dir" && target.rel ? `/${target.rel}/` : `/${target.rel}`;
    let levels: TreeLevels = new Map();
    let errorTags: Map<string, Tag> | undefined;
    try {
      // Read first: if tagging fails the tree still renders, only the tags go.
      levels = readTreeLevels(root, target.rel, target.kind === "dir");
      errorTags = await tagLevels(root, levels);
    } catch {
      // The error page must render even if the tree cannot be tagged.
    }
    return htmlResponse(
      renderError({
        rootLabel,
        path,
        sidebar: renderSidebar(root, target.rel, errorTags, levels),
        status,
        message: status === 403 ? "Permission denied" : "Could not read this path",
      }),
      status,
    );
  }
}

/** Build the response in-process so routing is testable without binding a port. */
export async function respond(
  root: string,
  requestUrl: string,
  headers?: RequestHeaders,
  method = "GET",
): Promise<Response> {
  const response = await route(root, requestUrl, headers);
  if (method !== "HEAD") return response;
  return new Response(null, { status: response.status, headers: response.headers });
}
