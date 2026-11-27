import { createHighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubLight from "@shikijs/themes/github-light";
import githubDark from "@shikijs/themes/github-dark";

/** Extensions with a grammar that the JavaScript regex engine handles cleanly. */
const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".php": "php",
  ".lua": "lua",
  ".pl": "perl",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".toml": "toml",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".ini": "ini",
  ".env": "dotenv",
  ".sql": "sql",
  ".xml": "xml",
  ".patch": "diff",
  ".diff": "diff",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "proto",
  ".svelte": "svelte",
  ".vue": "vue",
  ".astro": "astro",
  ".tf": "terraform",
  ".hcl": "hcl",
  ".gradle": "groovy",
  ".properties": "properties",
  ".json": "json",
  ".map": "json",
  ".geojson": "json",
  ".webmanifest": "json",
};

// Per-language modules keep the other grammars off the heap until a file needs them.
type LangModule = { default: LanguageRegistration[] };
const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  swift: () => import("@shikijs/langs/swift"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  php: () => import("@shikijs/langs/php"),
  lua: () => import("@shikijs/langs/lua"),
  perl: () => import("@shikijs/langs/perl"),
  bash: () => import("@shikijs/langs/bash"),
  fish: () => import("@shikijs/langs/fish"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  toml: () => import("@shikijs/langs/toml"),
  yaml: () => import("@shikijs/langs/yaml"),
  ini: () => import("@shikijs/langs/ini"),
  dotenv: () => import("@shikijs/langs/dotenv"),
  sql: () => import("@shikijs/langs/sql"),
  xml: () => import("@shikijs/langs/xml"),
  diff: () => import("@shikijs/langs/diff"),
  graphql: () => import("@shikijs/langs/graphql"),
  proto: () => import("@shikijs/langs/proto"),
  svelte: () => import("@shikijs/langs/svelte"),
  vue: () => import("@shikijs/langs/vue"),
  astro: () => import("@shikijs/langs/astro"),
  terraform: () => import("@shikijs/langs/terraform"),
  hcl: () => import("@shikijs/langs/hcl"),
  groovy: () => import("@shikijs/langs/groovy"),
  properties: () => import("@shikijs/langs/properties"),
  json: () => import("@shikijs/langs/json"),
};

/** Past this size a single request's tokenizing and markup cost stops paying off. */
export const HIGHLIGHT_LIMIT = 512 * 1024;
/** A dense file at that size still yields ~12 MB of spans; bound it by lines too. */
export const HIGHLIGHT_LINE_LIMIT = 2000;

let highlighterPromise: ReturnType<typeof createHighlighterCore> | undefined;
const loadedLangs = new Set<string>();
const pendingLangs = new Map<string, Promise<void>>();

function highlighter(): ReturnType<typeof createHighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubLight, githubDark],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
    // A failed creation is retried by the next file instead of poisoning the process.
    highlighterPromise.catch(() => {
      highlighterPromise = undefined;
    });
  }
  return highlighterPromise;
}

async function ensureLanguage(lang: string): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  const load = LANG_LOADERS[lang];
  if (!load) return false;
  let pending = pendingLangs.get(lang);
  if (!pending) {
    pending = (async () => {
      const shiki = await highlighter();
      await shiki.loadLanguage(load());
      loadedLangs.add(lang);
    })();
    pendingLangs.set(lang, pending);
  }
  try {
    await pending;
    return true;
  } catch {
    pendingLangs.delete(lang); // Let a later request retry the grammar.
    return false;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;");
}

/** Shiki tokens to `<code>` contents; newlines keep the existing gutter aligned. */
function tokensToHtml(lines: ThemedToken[][]): string {
  let html = "";
  for (let l = 0; l < lines.length; l++) {
    if (l > 0) html += "\n";
    const line = lines[l]!;
    for (let i = 0; i < line.length; i++) {
      const token = line[i]!;
      const content = escapeHtml(token.content);
      const style = token.htmlStyle;
      if (!style) {
        html += content;
        continue;
      }
      let css = "";
      for (const key in style) {
        // Token backgrounds would fight serv's own surface color.
        if (key === "background" || key === "background-color") continue;
        css += `${key}:${style[key]};`;
      }
      html += css ? `<span style="${css}">${content}</span>` : content;
    }
  }
  return html;
}

/**
 * Server-rendered highlighted `<code>` HTML, or undefined to stay plain.
 * Never throws: highlighting is an enhancement, so an error costs color only.
 */
export async function highlightSource(text: string, ext: string): Promise<string | undefined> {
  const lang = LANG_BY_EXT[ext];
  if (!lang) return undefined;
  // Keep the same trailing-newline rule as render's sourceBody, or the gutter drifts.
  const code = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (Buffer.byteLength(code) > HIGHLIGHT_LIMIT) return undefined;
  let lineCount = 1;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) === 10 && ++lineCount > HIGHLIGHT_LINE_LIMIT) return undefined;
  }
  try {
    if (!(await ensureLanguage(lang))) return undefined;
    const shiki = await highlighter();
    const { tokens } = shiki.codeToTokens(code, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    return tokensToHtml(tokens);
  } catch {
    return undefined;
  }
}
