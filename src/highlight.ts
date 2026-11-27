import { createHighlighterCore, type LanguageRegistration, type ThemedToken } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import githubLight from "shiki/themes/github-light.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import { escapeHtml } from "./render";

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
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  less: () => import("shiki/langs/less.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  dotenv: () => import("shiki/langs/dotenv.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  proto: () => import("shiki/langs/proto.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  astro: () => import("shiki/langs/astro.mjs"),
  terraform: () => import("shiki/langs/terraform.mjs"),
  hcl: () => import("shiki/langs/hcl.mjs"),
  groovy: () => import("shiki/langs/groovy.mjs"),
  properties: () => import("shiki/langs/properties.mjs"),
  json: () => import("shiki/langs/json.mjs"),
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
