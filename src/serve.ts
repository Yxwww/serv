import { closeSync, openSync, readSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { listEntries, renderListing, renderMarkdownHtml, renderMarkdownPage, renderNotFound } from "./render";

export type Input = { kind: "dir" | "file"; root: string; startPath: string };

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

export type Resolved =
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
  if (target !== root && !target.startsWith(root + sep)) return { kind: "outside" };

  let stat;
  try {
    stat = statSync(target);
  } catch {
    return { kind: "missing" };
  }
  const rel = parts.join("/");
  return stat.isDirectory() ? { kind: "dir", path: target, rel } : { kind: "file", path: target, rel };
}

// Bun maps .ts to video/mp2t (and .toml/.sh to types browsers download). Serve
// anything whose bytes are text as text/plain so the tab displays it instead.
const TEXT_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".toml", ".yaml", ".yml", ".sh", ".bash", ".zsh", ".fish",
  ".log", ".txt", ".ini", ".cfg", ".conf", ".env", ".sql",
  ".css", ".scss", ".less", ".csv", ".tsv", ".map",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp",
  ".swift", ".kt", ".php", ".lua", ".pl",
]);

function isMarkdown(ext: string): boolean {
  return ext === ".md" || ext === ".markdown";
}

function looksText(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
    return true;
  } finally {
    closeSync(fd);
  }
}

export function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (TEXT_EXTS.has(ext) || isMarkdown(ext)) return "text/plain; charset=utf-8";
  if (!ext) return looksText(path) ? "text/plain; charset=utf-8" : "application/octet-stream";
  return Bun.file(path).type || "application/octet-stream";
}

function fileResponse(path: string, type = contentTypeFor(path)): Response {
  return new Response(Bun.file(path), { headers: { "content-type": type } });
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Build the response in-process so routing is testable without binding a port. */
export async function respond(root: string, requestUrl: string): Promise<Response> {
  const url = new URL(requestUrl, "http://127.0.0.1");
  const target = resolveRequest(root, url.pathname);
  const rootLabel = basename(root);

  if (target.kind === "outside") return textResponse("Forbidden\n", 403);
  if (target.kind === "missing") {
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Keep the encoded form rather than failing the 404 page.
    }
    return htmlResponse(renderNotFound({ rootLabel, path }), 404);
  }

  if (target.kind === "dir") {
    // A trailing slash makes relative links on the page resolve inside the directory.
    if (!url.pathname.endsWith("/")) {
      return new Response(null, { status: 308, headers: { location: url.pathname + "/" + url.search } });
    }
    const index = join(target.path, "index.html");
    if (isFile(index)) return fileResponse(index);

    const readme = join(target.path, "README.md");
    const readmeHtml = isFile(readme) ? renderMarkdownHtml(await Bun.file(readme).text()) : undefined;
    return htmlResponse(
      renderListing({ rootLabel, rel: target.rel, entries: listEntries(target.path), readmeHtml }),
    );
  }

  const ext = extname(target.path).toLowerCase();
  if (isMarkdown(ext)) {
    if (url.searchParams.has("raw")) return fileResponse(target.path, "text/plain; charset=utf-8");
    const markdown = await Bun.file(target.path).text();
    return htmlResponse(renderMarkdownPage({ markdown, rootLabel, rel: target.rel }));
  }

  return fileResponse(target.path);
}
