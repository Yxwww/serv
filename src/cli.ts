#!/usr/bin/env bun
/**
 * Browse a folder (or one file) in the browser. Markdown renders; anything the
 * browser shows natively is served as-is.
 *
 *   serv [path] [--port N] [--no-open] [--base DIR]
 *
 * `--base` resolves a relative path against another directory, for wrappers
 * that launch the CLI from a different working directory.
 */
import { openBrowser } from "./open";
import { resolveInput, respond } from "./serve";

const DEFAULT_PORT = 4400;
const PORT_TRIES = 50;
// Hash into a block of 500 ports so each folder gets a stable, memorable URL.
const PORT_RANGE = 500;

const USAGE = `usage: serv [path] [--port N] [--no-open] [--base DIR]

  path      file or directory to serve (default: --base, i.e. the invocation dir)
  --port    first port to try (default: derived from the folder, 4400-4899; next free one if taken)
  --no-open do not open the browser
  --base    resolve a relative path against this directory
`;

type Args = { path: string; base: string; port: number | null; open: boolean };

/** Deterministic port for a folder, so rerunning serv reuses the same URL. */
export function folderPort(root: string): number {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < root.length; i++) {
    hash ^= root.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return DEFAULT_PORT + ((hash >>> 0) % PORT_RANGE);
}

export function parseArgs(argv: string[], cwd = process.cwd()): Args {
  const args: Args = { path: ".", base: cwd, port: null, open: true };
  const paths: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--no-open") {
      args.open = false;
    } else if (arg === "--port" || arg === "--base") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} needs a value`);
      if (arg === "--port") args.port = parsePort(value);
      else args.base = value;
    } else if (arg.startsWith("--port=")) {
      args.port = parsePort(arg.slice("--port=".length));
    } else if (arg.startsWith("--base=")) {
      args.base = arg.slice("--base=".length);
    } else if (arg === "-h" || arg === "--help") {
      throw new UsageError();
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown flag: ${arg}`);
    } else {
      paths.push(arg);
    }
  }

  if (paths.length > 1) throw new Error(`expected one path, got ${paths.length}`);
  if (paths[0]) args.path = paths[0];
  return args;
}

class UsageError extends Error {}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`bad port: ${value}`);
  return port;
}

/** Bind 127.0.0.1, walking forward from the requested port on EADDRINUSE. */
function listen(root: string, startPort: number) {
  for (let port = startPort; port < startPort + PORT_TRIES && port <= 65535; port++) {
    try {
      return Bun.serve({ hostname: "127.0.0.1", port, fetch: (req) => respond(root, req.url, req.headers, req.method) });
    } catch (e) {
      const text = `${(e as { code?: string }).code ?? ""} ${String(e)}`;
      if (!text.includes("EADDRINUSE")) throw e;
    }
  }
  throw new Error(`no free port in ${startPort}..${startPort + PORT_TRIES - 1}`);
}

const main = async (argv: string[]): Promise<number> => {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stdout.write(USAGE);
      return 0;
    }
    process.stderr.write(`serv: ${(e as Error).message}\n${USAGE}`);
    return 2;
  }

  let input;
  try {
    input = resolveInput(args.path, args.base);
  } catch {
    process.stderr.write(`serv: no such file or directory: ${args.path}\n`);
    return 1;
  }

  let server;
  try {
    server = listen(input.root, args.port ?? folderPort(input.root));
  } catch (e) {
    process.stderr.write(`serv: ${(e as Error).message}\n`);
    return 1;
  }

  const url = `http://127.0.0.1:${server.port}${input.startPath}`;
  process.stdout.write(`serving ${input.root}\n${url}\n`);
  if (args.open) openBrowser(url);
  return 0;
};

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  // On success the Bun.serve handle keeps the process alive; only errors exit early.
  if (code !== 0) process.exit(code);
}
