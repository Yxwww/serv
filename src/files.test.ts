import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combineFiles, entriesUnder, readFiles, scanFiles, tagRows, walkFiles } from "./files";

const tmp = mkdtempSync(join(tmpdir(), "serv-files-test-"));
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

function commitAll(dir: string): void {
  for (const args of [
    ["git", "-C", dir, "add", "-A"],
    ["git", "-C", dir, "-c", "user.name=serv", "-c", "user.email=serv@example.com", "commit", "-qm", "init"],
  ]) {
    const run = Bun.spawnSync(args, { stdout: "ignore", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
  }
}

describe("combineFiles", () => {
  test("lists in path order and fills the cap with real paths first", () => {
    const listed = combineFiles(
      { files: ["a.txt", "src/y.js"], truncated: false },
      { files: ["a.txt", "dist/x.js", "src/y.js"], truncated: false },
      10,
    );
    expect(listed.entries).toEqual([
      { path: "a.txt" },
      { path: "dist/", ignored: true },
      { path: "dist/x.js", ignored: true },
      { path: "src/" },
      { path: "src/y.js" },
    ]);
    expect(listed.truncated).toBe(false);

    // The cap is decided by tags, then the survivors are shown in path order.
    const capped = combineFiles(
      { files: ["z.txt"], truncated: false },
      { files: ["z.txt", "a/ignored.txt"], truncated: false },
      2,
    );
    expect(capped.entries).toEqual([
      { path: "a/", ignored: true },
      { path: "z.txt" },
    ]);
    expect(capped.truncated).toBe(true);

    const realOnly = combineFiles(
      { files: ["z.txt"], truncated: false },
      { files: ["z.txt", "a/ignored.txt"], truncated: false },
      1,
    );
    expect(realOnly.entries).toEqual([{ path: "z.txt" }]);
  });
});

describe("entriesUnder", () => {
  test("does not inherit the root cap", () => {
    expect(entriesUnder({ entries: [{ path: "sub/a.txt" }], truncated: true }, "sub")).toEqual({
      entries: [{ path: "a.txt" }],
      truncated: false,
    });
  });
});

describe("scanFiles", () => {
  test("concurrent cold requests share one collection", async () => {
    const dir = fixtureDir("files-inflight");
    writeFileSync(join(dir, "a.txt"), "x");

    const first = scanFiles(dir);
    const second = scanFiles(dir);
    expect(second).toBe(first);
    expect(await first).toEqual({ entries: [{ path: "a.txt" }], truncated: false });
  });
});

describe("readFiles", () => {
  test("stops at the cap and tells the producer to stop", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("a\0b\0c"));
        controller.enqueue(encoder.encode("\0d\0e\0"));
        controller.close();
      },
    });
    let stopped = 0;
    expect(await readFiles(stream, 3, () => stopped++)).toEqual({
      files: ["a", "b", "c"],
      truncated: true,
    });
    expect(stopped).toBe(1);
  });
});

describe("walkFiles", () => {
  test("includes dotfiles and skips .git and symlinks", () => {
    const dir = fixtureDir("files-walk");
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, "node_modules"));
    writeFileSync(join(dir, "a.txt"), "x");
    writeFileSync(join(dir, ".hidden"), "x");
    writeFileSync(join(dir, "sub", "b.md"), "x");
    writeFileSync(join(dir, ".git", "config"), "x");
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    const target = join(tmp, "walk-target.txt");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "link.txt"));
    symlinkSync(dir, join(dir, "loop"));

    expect(walkFiles(dir, 100)).toEqual({
      files: [".hidden", "a.txt", "node_modules/x.js", "sub/b.md"],
      truncated: false,
    });
    const capped = walkFiles(dir, 2);
    expect(capped.files).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });
});

describe("tagRows", () => {
  test.skipIf(!Bun.which("git"))(
    "ignores parent rules but keeps the served tree's own rules",
    async () => {
      const parent = fixtureDir("tag-parent");
      initRepo(parent);
      writeFileSync(join(parent, ".gitignore"), "child/**\n");
      const child = join(parent, "child");
      mkdirSync(child);
      writeFileSync(join(child, ".gitignore"), "inside.txt\n");
      writeFileSync(join(child, "inside.txt"), "x");
      writeFileSync(join(child, "other.txt"), "x");

      const tags = await tagRows(child, [{ path: "inside.txt" }, { path: "other.txt" }]);
      expect(tags.get("inside.txt")).toEqual({ path: "inside.txt", ignored: true });
      expect(tags.has("other.txt")).toBe(false);
    },
  );

  test.skipIf(!Bun.which("git"))(
    "a submodule row does not clear the other tags on the page",
    async () => {
      const source = fixtureDir("tag-submodule-source");
      initRepo(source);
      writeFileSync(join(source, "inside.txt"), "x");
      commitAll(source);

      const parent = fixtureDir("tag-submodule-parent");
      initRepo(parent);
      writeFileSync(join(parent, ".gitignore"), "out/\n");
      writeFileSync(join(parent, "visible.txt"), "x");
      mkdirSync(join(parent, "out"));
      writeFileSync(join(parent, "out", "bundle.js"), "x");
      commitAll(parent);

      const add = Bun.spawnSync(
        ["git", "-C", parent, "-c", "protocol.file.allow=always", "submodule", "add", source, "vendor/sub"],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(add.exitCode, add.stderr.toString()).toBe(0);
      // A submodule worktree root has a .git file; check-ignore rejects it.
      expect(lstatSync(join(parent, "vendor", "sub", ".git")).isFile()).toBe(true);

      const tags = await tagRows(parent, [
        { path: "out/" },
        { path: "vendor/" },
        { path: "vendor/sub/" },
        { path: "vendor/sub/inside.txt" },
        { path: "visible.txt" },
      ]);
      expect(tags.get("out/")).toEqual({ path: "out/", ignored: true });
      expect(tags.has("vendor/")).toBe(false);
      expect(tags.has("vendor/sub/")).toBe(false);
      expect(tags.has("vendor/sub/inside.txt")).toBe(false);
      expect(tags.has("visible.txt")).toBe(false);
    },
  );

  test("leaves ignored tags off outside a git repo", async () => {
    const dir = fixtureDir("tag-norepo");
    writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
    writeFileSync(join(dir, "secret.txt"), "x");

    const tags = await tagRows(dir, [{ path: "secret.txt" }]);
    expect(tags.has("secret.txt")).toBe(false);
  });
});
