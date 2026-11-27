import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const cliPath = join(import.meta.dir, "cli.ts");

type Cli = Bun.Subprocess<"ignore", "pipe", "pipe">;

function spawnCli(root: string): Cli {
  return Bun.spawn([process.execPath, cliPath, root, "--port", "0", "--no-open"], {
    cwd: repoRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The cli prints `serving <root>\n<url>` only after Bun.serve has bound the port. */
async function waitForUrl(proc: Cli): Promise<string> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`cli exited before serving\n${stderr}`);
    }
    buffered += decoder.decode(value, { stream: true });
    const match = /http:\/\/127\.0\.0\.1:\d+\/[^\s]*/.exec(buffered);
    if (match) return match[0];
  }
}

async function stopCli(proc: Cli): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  try {
    await proc.exited;
  } finally {
    clearTimeout(timer);
  }
}

const root = mkdtempSync(join(tmpdir(), "serv-cli-e2e-"));
let server: Cli | undefined;
let base = "";

function page(path: string, headers?: Record<string, string>): Promise<Response> {
  return fetch(base + path, { headers });
}

beforeAll(async () => {
  mkdirSync(join(root, "nested"), { recursive: true });
  writeFileSync(join(root, "app.ts"), 'const html = "<b>&";\nexport const x = 1;\n');
  writeFileSync(join(root, "data.json"), '{"b":2,"a":1}');
  writeFileSync(join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
  writeFileSync(join(root, "Cargo.lock"), "# lock-marker\n");
  writeFileSync(join(root, "broken.json"), '{ "a": }');
  writeFileSync(join(root, "big.ts"), "const x = 1;\n".repeat(2001));
  writeFileSync(join(root, "README.md"), "# Fixture heading\n\nRendered paragraph.\n");
  writeFileSync(join(root, "nested", "notes.ts"), "export const nested = true;\n");

  server = spawnCli(root);
  base = await withTimeout(waitForUrl(server), 15000, "cli did not print a URL within 15s");
});

afterAll(async () => {
  if (server) await stopCli(server);
  rmSync(root, { recursive: true, force: true });
});

describe("serv cli", () => {
  test("directory listing, nested listing and Markdown render as before", async () => {
    const listing = await page("");
    expect(listing.status).toBe(200);
    expect(listing.headers.get("content-type")).toStartWith("text/html");
    const html = await listing.text();
    expect(html).toContain("app.ts");
    expect(html).toContain("nested/");

    const nested = await page("nested/");
    expect(nested.status).toBe(200);
    expect(await nested.text()).toContain("notes.ts");

    const readme = await page("README.md");
    expect(readme.status).toBe(200);
    const markdown = await readme.text();
    expect(markdown).toContain('<h1 id="fixture-heading"><a href="#fixture-heading">Fixture heading</a></h1>');
    expect(markdown).toContain("<p>Rendered paragraph.</p>");
  });

  test("listing references the cached icon sprite and the sprite serves", async () => {
    const html = await (await page("")).text();
    const match = /href="(\/\?icons=[^"#]+)#fi-[^"]+"/.exec(html);
    expect(match).not.toBeNull();

    const response = await page(match![1]!.replace(/^\//, ""));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    const sprite = await response.text();
    expect(sprite).toContain('<symbol id="fi-file-type-ts"');
    expect(sprite).toContain('<symbol id="fi-folder"');
  });

  test("TypeScript source is highlighted and escaped", async () => {
    const response = await page("app.ts");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("text/html");
    const html = await response.text();
    expect(html).toContain('<pre class="gutter" aria-hidden="true">1\n2</pre>');
    expect(html).toContain("--shiki-light:#");
    expect(html).toContain("--shiki-dark:#");
    expect(html).toContain("&lt;b&gt;&amp;");
    expect(html).not.toContain("<b>");
  });

  test("JSON as a document is pretty-printed and highlighted; otherwise raw", async () => {
    const html = await (await page("tsconfig.json", { "sec-fetch-dest": "document" })).text();
    expect(html).toContain('<pre class="gutter" aria-hidden="true">1\n2\n3\n4\n5</pre>');
    expect(html).toContain("&quot;compilerOptions&quot;</span>");
    expect(html).toContain("--shiki-light:#");
    expect(html).toContain("--shiki-dark:#");

    const raw = await page("data.json");
    expect(raw.headers.get("content-type")).toStartWith("application/json");
    expect(await raw.text()).toBe('{"b":2,"a":1}');
  });

  test("unnamed grammars, invalid JSON and the line cap stay plain", async () => {
    const lock = await (await page("Cargo.lock")).text();
    expect(lock).toContain("# lock-marker");
    expect(lock).not.toContain('<span style="--shiki-');

    const broken = await (await page("broken.json", { "sec-fetch-dest": "document" })).text();
    expect(broken).toContain("&quot;a&quot;");
    expect(broken).not.toContain('<span style="--shiki-');

    const big = await (await page("big.ts")).text();
    expect(big).toContain("<code>const x = 1;");
    expect(big).not.toContain('<span style="--shiki-');
  });

  test("a missing path returns 404", async () => {
    const response = await page("does-not-exist");
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("was not found");
  });

  test("SIGTERM stops the server", async () => {
    const proc = spawnCli(root);
    try {
      const url = await withTimeout(waitForUrl(proc), 15000, "second cli did not print a URL within 15s");
      expect((await fetch(url)).status).toBe(200);
      proc.kill("SIGTERM");
      expect(await withTimeout(proc.exited, 5000, "SIGTERM did not stop the cli")).toBe(143);
      expect(proc.signalCode).toBe("SIGTERM");
    } finally {
      await stopCli(proc);
    }
  });
});
