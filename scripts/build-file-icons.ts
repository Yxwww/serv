import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  AUDIO_EXTS,
  CODE_EXTS,
  HTML_EXTS,
  IMAGE_EXTS,
  JS_EXTS,
  JSON_EXTS,
  TEXT_EXTS,
  VIDEO_EXTS,
  isMarkdown,
} from "../src/types.ts";

// Checked against @tabler/icons 3.53.0; every name must exist in the package.
const ICON_NAMES = [
  "brand-astro",
  "brand-c-sharp",
  "brand-cpp",
  "brand-docker",
  "brand-git",
  "brand-golang",
  "brand-graphql",
  "brand-kotlin",
  "brand-nodejs",
  "brand-npm",
  "brand-python",
  "brand-rust",
  "brand-sass",
  "brand-svelte",
  "brand-swift",
  "brand-terraform",
  "file",
  "file-certificate",
  "file-code",
  "file-diff",
  "file-music",
  "file-settings",
  "file-text",
  "file-type-css",
  "file-type-csv",
  "file-type-html",
  "file-type-jpg",
  "file-type-js",
  "file-type-jsx",
  "file-type-pdf",
  "file-type-php",
  "file-type-png",
  "file-type-sql",
  "file-type-svg",
  "file-type-ts",
  "file-type-tsx",
  "file-type-txt",
  "file-type-vue",
  "file-type-xml",
  "file-type-zip",
  "folder",
  "folder-open",
  "json",
  "lock",
  "markdown",
  "menu",
  "message",
  "photo",
  "video",
  "x",
] as const;

type IconId = (typeof ICON_NAMES)[number];

const EXTENSION_ICONS: Record<string, IconId> = {
  // Images without a dedicated Tabler glyph share `photo`.
  ".png": "file-type-png",
  ".jpg": "file-type-jpg",
  ".jpeg": "file-type-jpg",
  ".svg": "file-type-svg",
  ".gif": "photo",
  ".webp": "photo",
  ".avif": "photo",
  ".ico": "photo",
  ".bmp": "photo",

  ".json": "json",
  ".map": "json",
  ".geojson": "json",
  ".webmanifest": "json",

  ".mp4": "video",
  ".webm": "video",
  ".ogv": "video",
  ".mov": "video",
  ".m4v": "video",

  ".mp3": "file-music",
  ".wav": "file-music",
  ".ogg": "file-music",
  ".oga": "file-music",
  ".m4a": "file-music",
  ".flac": "file-music",
  ".aac": "file-music",

  ".html": "file-type-html",
  ".htm": "file-type-html",

  ".ts": "file-type-ts",
  ".tsx": "file-type-tsx",
  ".js": "file-type-js",
  ".mjs": "file-type-js",
  ".cjs": "file-type-js",
  ".jsx": "file-type-jsx",

  ".py": "brand-python",
  ".go": "brand-golang",
  ".rs": "brand-rust",
  ".rb": "file-code",
  ".java": "file-code",
  ".c": "file-code",
  ".h": "file-code",
  ".cpp": "brand-cpp",
  ".hpp": "brand-cpp",
  ".cs": "brand-c-sharp",
  ".swift": "brand-swift",
  ".kt": "brand-kotlin",
  ".php": "file-type-php",
  ".lua": "file-code",
  ".pl": "file-code",
  ".sh": "file-code",
  ".bash": "file-code",
  ".zsh": "file-code",
  ".fish": "file-code",
  ".css": "file-type-css",
  ".scss": "brand-sass",
  ".less": "brand-sass",
  ".toml": "file-settings",
  ".yaml": "file-settings",
  ".yml": "file-settings",
  ".ini": "file-settings",
  ".cfg": "file-settings",
  ".conf": "file-settings",
  ".env": "file-settings",
  ".sql": "file-type-sql",
  ".xml": "file-type-xml",
  ".lock": "lock",
  ".patch": "file-diff",
  ".diff": "file-diff",
  ".graphql": "brand-graphql",
  ".gql": "brand-graphql",
  ".proto": "file-code",
  ".svelte": "brand-svelte",
  ".vue": "file-type-vue",
  ".astro": "brand-astro",
  ".tf": "brand-terraform",
  ".hcl": "brand-terraform",
  ".gradle": "file-settings",
  ".properties": "file-settings",

  ".txt": "file-type-txt",
  ".log": "file-text",
  ".csv": "file-type-csv",
  ".tsv": "file-type-csv",
  ".rst": "file-text",
  ".mdx": "markdown",
  ".md": "markdown",
  ".markdown": "markdown",

  // Not routing types, but common enough to name here.
  ".pdf": "file-type-pdf",
  ".zip": "file-type-zip",
  ".gz": "file-type-zip",
  ".tgz": "file-type-zip",
  ".tar": "file-type-zip",
  ".bz2": "file-type-zip",
  ".xz": "file-type-zip",
  ".7z": "file-type-zip",
  ".rar": "file-type-zip",
};

const SPECIAL_NAMES: Record<string, IconId> = {
  "package.json": "brand-npm",
  "package-lock.json": "brand-npm",
  "bun.lock": "lock",
  "bun.lockb": "lock",
  "yarn.lock": "lock",
  "pnpm-lock.yaml": "lock",
  dockerfile: "brand-docker",
  "docker-compose.yml": "brand-docker",
  ".dockerignore": "brand-docker",
  ".gitignore": "brand-git",
  ".gitattributes": "brand-git",
  ".gitmodules": "brand-git",
  "tsconfig.json": "file-settings",
  "jsconfig.json": "file-settings",
  "readme.md": "markdown",
  license: "file-certificate",
  licence: "file-certificate",
  makefile: "file-settings",
  ".editorconfig": "file-settings",
  ".npmrc": "brand-npm",
  ".nvmrc": "brand-nodejs",
  ".python-version": "brand-python",
  ".env": "file-settings",
  ".babelrc": "file-settings",
  ".browserslistrc": "file-settings",
  ".eslintignore": "file-settings",
  ".eslintrc": "file-settings",
  ".htaccess": "file-settings",
  ".mailmap": "file-settings",
  ".prettierignore": "file-settings",
  ".prettierrc": "file-settings",
  ".ruby-version": "file-settings",
  ".stylelintrc": "file-settings",
  ".tool-versions": "file-settings",
  ".watchmanconfig": "file-settings",
  ".yarnrc": "file-settings",
};

const ROOT = join(import.meta.dir, "..");
const OUTLINE = join(ROOT, "node_modules", "@tabler", "icons", "icons", "outline");
const outArg = process.argv[2];
const OUT_DIR = outArg ? (isAbsolute(outArg) ? outArg : join(process.cwd(), outArg)) : join(ROOT, "src");

function fail(message: string): never {
  console.error(`build-file-icons: ${message}`);
  process.exit(1);
}

const known = new Set<string>(ICON_NAMES);
for (const [ext, id] of Object.entries(EXTENSION_ICONS)) {
  if (!known.has(id)) fail(`${ext} points at unknown icon ${id}`);
}
for (const [name, id] of Object.entries(SPECIAL_NAMES)) {
  if (!known.has(id)) fail(`${name} points at unknown icon ${id}`);
}

// Every extension serv recognises must have a glyph, or the fallback test lies.
for (const set of [IMAGE_EXTS, JSON_EXTS, VIDEO_EXTS, AUDIO_EXTS, HTML_EXTS, JS_EXTS, CODE_EXTS, TEXT_EXTS]) {
  for (const ext of set) if (!EXTENSION_ICONS[ext]) fail(`no icon mapped for ${ext}`);
}
for (const ext of [".md", ".markdown"]) {
  if (isMarkdown(ext) && !EXTENSION_ICONS[ext]) fail(`no icon mapped for ${ext}`);
}

function svgInner(name: string): string {
  let svg: string;
  try {
    svg = readFileSync(join(OUTLINE, `${name}.svg`), "utf8");
  } catch {
    fail(`missing @tabler/icons outline icon ${name}`);
  }
  const open = svg.indexOf(">", svg.indexOf("<svg"));
  const close = svg.lastIndexOf("</svg>");
  if (open < 0 || close < 0) fail(`${name}.svg is not an SVG`);
  return svg
    .slice(open + 1, close)
    .replace(/<path\s+stroke="none"\s+d="M0 0h24v24H0z"\s+fill="none"\s*\/>/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s+\/>/g, "/>")
    .trim();
}

function symbol(name: string): string {
  // Stroke width lives on the symbol so every glyph matches the house style.
  const inner = svgInner(name);
  return `<symbol id="fi-${name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>`;
}

const sortedIcons = [...ICON_NAMES].sort();
const sprite = `<svg xmlns="http://www.w3.org/2000/svg">${sortedIcons.map(symbol).join("")}</svg>`;

// A content hash makes the sprite URL immutable; a changed glyph changes it.
const hash = createHash("sha256").update(sprite).digest("hex").slice(0, 12);
const spriteUrl = `/?icons=${hash}`;

function mapLiteral(entries: Iterable<[string, IconId]>): string {
  let out = "";
  for (const [key, id] of entries) out += `  [${JSON.stringify(key)}, ${JSON.stringify(id)}],\n`;
  return out;
}

const extensionEntries = Object.entries(EXTENSION_ICONS).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const specialEntries = Object.entries(SPECIAL_NAMES).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const iconsFile = `// Generated by scripts/build-file-icons.ts. Do not edit.
export type IconId =
${sortedIcons.map((id) => `  | ${JSON.stringify(id)}`).join("\n")};

export const SPRITE_HASH = ${JSON.stringify(hash)};
export const SPRITE_URL = ${JSON.stringify(spriteUrl)};

export const EXTENSION_ICONS: ReadonlyMap<string, IconId> = new Map<string, IconId>([
${mapLiteral(extensionEntries)}]);

export const SPECIAL_NAMES: ReadonlyMap<string, IconId> = new Map<string, IconId>([
${mapLiteral(specialEntries)}]);

/** Hot path: one folded copy, two map lookups, no regex. */
export function iconIdFor(name: string, isDir: boolean): IconId {
  if (isDir) return "folder";
  const lower = name.toLowerCase();
  const special = SPECIAL_NAMES.get(lower);
  if (special !== undefined) return special;
  if (lower.startsWith(".env.")) return "file-settings";
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot) : "";
  return EXTENSION_ICONS.get(ext) ?? "file";
}
`;

const spriteFile = `// Generated by scripts/build-file-icons.ts. Do not edit.
export const SPRITE = ${JSON.stringify(sprite)};
`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "file-icons.ts"), iconsFile);
writeFileSync(join(OUT_DIR, "file-icon-sprite.ts"), spriteFile);

console.log(
  `build-file-icons: ${sortedIcons.length} symbols, ${Buffer.byteLength(sprite)} bytes, ${spriteUrl}`,
);
