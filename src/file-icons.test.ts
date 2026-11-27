import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SPRITE } from "./file-icon-sprite";
import { EXTENSION_ICONS, SPECIAL_NAMES, SPRITE_HASH, SPRITE_URL, iconIdFor, type IconId } from "./file-icons";
import { hasIconMarkup, paletteIcon } from "./icons";
import { respond } from "./serve";
import {
  AUDIO_EXTS,
  CODE_EXTS,
  HTML_EXTS,
  IMAGE_EXTS,
  JS_EXTS,
  JSON_EXTS,
  TEXT_EXTS,
  VIDEO_EXTS,
} from "./types";

const tmp = mkdtempSync(join(tmpdir(), "serv-icons-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function fixtureDir(name: string): string {
  const dir = join(tmp, `${n++}-${name}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const symbolIds = [...SPRITE.matchAll(/<symbol id="fi-([^"]+)"/g)].map((m) => m[1]!);
const symbolSet = new Set(symbolIds);

function useIds(html: string): string[] {
  return [...html.matchAll(/<use href="[^"]*#fi-([^"]+)"/g)].map((m) => m[1]!);
}

describe("file icon mapping", () => {
  test("covers every routed extension and special name with a unique sprite id", () => {
    expect(symbolSet.size).toBe(symbolIds.length);
    expect(SPRITE_URL).toBe(`/?icons=${SPRITE_HASH}`);

    const sets = [IMAGE_EXTS, JSON_EXTS, VIDEO_EXTS, AUDIO_EXTS, HTML_EXTS, JS_EXTS, CODE_EXTS, TEXT_EXTS];
    for (const set of sets) {
      for (const ext of set) {
        const id = iconIdFor("file" + ext, false);
        expect(EXTENSION_ICONS.has(ext), ext).toBe(true);
        expect(symbolSet.has(id), ext).toBe(true);
      }
    }
    for (const ext of [".md", ".markdown"]) {
      expect(symbolSet.has(iconIdFor("file" + ext, false)), ext).toBe(true);
    }
    for (const name of SPECIAL_NAMES.keys()) {
      expect(symbolSet.has(iconIdFor(name, false)), name).toBe(true);
    }
    for (const name of [".env.local", ".env.production", ".env.test"]) {
      expect(symbolSet.has(iconIdFor(name, false)), name).toBe(true);
    }
    expect(iconIdFor("anything", true)).toBe("folder");
    expect(symbolSet.has("folder")).toBe(true);
    expect(iconIdFor("mystery.qqq", false)).toBe("file");

    const reachable: IconId[] = [
      ...EXTENSION_ICONS.values(),
      ...SPECIAL_NAMES.values(),
      "file",
      "file-settings",
      "folder",
    ];
    for (const id of reachable) expect(hasIconMarkup(id), id).toBe(true);
  });

  test("matching is case-insensitive", () => {
    expect(iconIdFor("MAIN.TS", false)).toBe(iconIdFor("main.ts", false));
    expect(iconIdFor("PACKAGE.JSON", false)).toBe(iconIdFor("package.json", false));
    expect(iconIdFor("README.MD", false)).toBe(iconIdFor("readme.md", false));
    expect(iconIdFor("Dockerfile", false)).toBe("brand-docker");
  });
});

describe("rendered icons", () => {
  test("listing rows, tree fragments and palette rows only use sprite symbols", async () => {
    const dir = fixtureDir("rendered");
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "app.ts"), "x");
    writeFileSync(join(dir, "photo.png"), "x");
    writeFileSync(join(dir, "notes.md"), "x");
    writeFileSync(join(dir, "Dockerfile"), "x");
    writeFileSync(join(dir, "package.json"), "x");
    writeFileSync(join(dir, "mystery.qqq"), "x");
    writeFileSync(join(dir, "sub", "child.tsx"), "x");

    const html = await (await respond(dir, "http://localhost/")).text();
    expect(html).toContain(
      `<link rel="preload" as="image" type="image/svg+xml" href="${SPRITE_URL}">`,
    );
    const body = html.slice(html.indexOf("<tbody>"), html.indexOf("</tbody>"));
    // One <use> per row and no path data: the sprite carries every glyph once.
    expect(body).not.toContain("<path");
    expect(body).toContain(`<use href="${SPRITE_URL}#fi-`);
    expect(useIds(body).length).toBe(7);

    const gridHtml = await (await respond(dir, "http://localhost/?view=grid")).text();
    const gridStart = gridHtml.indexOf('<ul class="file-grid"');
    const grid = gridHtml.slice(gridStart, gridHtml.indexOf("</ul>", gridStart));
    // The image card uses <img>; the folder and five file cards use the sprite.
    expect(grid).not.toContain("<path");
    expect(grid).toContain(`<use href="${SPRITE_URL}#fi-`);
    expect(useIds(grid).length).toBe(6);

    const frag = await (await respond(dir, "http://localhost/sub/?tree")).text();
    expect(useIds(frag).length).toBe(1);

    const palette = ["app.ts", "sub/", "README.md", "Dockerfile", "mystery.qqq"]
      .map((path) => paletteIcon(path))
      .join("");
    expect(useIds(palette).length).toBe(5);

    for (const id of [...useIds(body), ...useIds(frag), ...useIds(palette)]) {
      expect(symbolSet.has(id), id).toBe(true);
    }
  });

  test("palette markup never contains the filename", () => {
    const markup = paletteIcon("evil<script>alert(1)</script>.ts");
    expect(markup).not.toContain("evil");
    expect(markup).not.toContain("<script");
    expect(markup).toContain("#fi-file-type-ts");
  });
});

describe("sprite route", () => {
  test("serves the sprite with long-lived cache headers", async () => {
    const dir = fixtureDir("sprite-route");
    const res = await respond(dir, `http://localhost/?icons=${SPRITE_HASH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("etag")).toBe(`"${SPRITE_HASH}"`);
    expect(await res.text()).toBe(SPRITE);

    const image = await respond(dir, `http://localhost/?icons=${SPRITE_HASH}`, {
      "sec-fetch-dest": "image",
    });
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");

    // Immutable means a stale hash must not pin old content.
    const stale = await respond(dir, "http://localhost/?icons=000000000000");
    expect(stale.status).toBe(404);
    expect(await stale.text()).not.toContain("<symbol");
  });

  test("a real file or folder named icons still works", async () => {
    const fileRoot = fixtureDir("real-file");
    writeFileSync(join(fileRoot, "icons"), "not a sprite");
    const file = await respond(fileRoot, "http://localhost/icons");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toStartWith("text/html");
    expect(await file.text()).not.toContain("<symbol");

    const dirRoot = fixtureDir("real-dir");
    mkdirSync(join(dirRoot, "icons"));
    writeFileSync(join(dirRoot, "icons", "child.ts"), "x");
    const listing = await respond(dirRoot, "http://localhost/icons/");
    expect(listing.status).toBe(200);
    expect(await listing.text()).toContain("child.ts");

    const sprite = await respond(dirRoot, `http://localhost/?icons=${SPRITE_HASH}`);
    expect(await sprite.text()).toBe(SPRITE);
  });
});

describe("icon build currency", () => {
  test("src/file-icons.ts and src/file-icon-sprite.ts are the current build", () => {
    const root = join(import.meta.dir, "..");
    const out = fixtureDir("icons-build");
    const run = Bun.spawnSync(
      [process.execPath, join(root, "scripts/build-file-icons.ts"), out],
      { cwd: root, stdout: "ignore", stderr: "pipe" },
    );
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(readFileSync(join(out, "file-icons.ts"), "utf8")).toBe(
      readFileSync(join(root, "src/file-icons.ts"), "utf8"),
    );
    expect(readFileSync(join(out, "file-icon-sprite.ts"), "utf8")).toBe(
      readFileSync(join(root, "src/file-icon-sprite.ts"), "utf8"),
    );
  });
});
