/** One extension table shared by routing, content types and sidebar icons. */
export const IMAGE_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico", ".bmp",
]);
export const JSON_EXTS = new Set([".json", ".map", ".geojson", ".webmanifest"]);
export const VIDEO_EXTS = new Set([".mp4", ".webm", ".ogv", ".mov", ".m4v"]);
export const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac"]);
export const HTML_EXTS = new Set([".html", ".htm"]);
export const JS_EXTS = new Set([".js", ".mjs", ".cjs", ".jsx"]);

export const CODE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".swift", ".kt", ".php", ".lua", ".pl",
  ".sh", ".bash", ".zsh", ".fish",
  ".css", ".scss", ".less",
  ".toml", ".yaml", ".yml", ".ini", ".cfg", ".conf", ".env",
  ".sql",
  ".xml", ".lock", ".patch", ".diff", ".graphql", ".gql", ".proto",
  ".svelte", ".vue", ".astro", ".tf", ".hcl", ".gradle", ".properties",
]);

export const TEXT_EXTS = new Set([".txt", ".log", ".csv", ".tsv", ".rst", ".mdx"]);

/** Dotfiles whose extension is absent or ambiguous; handled by name, not suffix. */
export const TEXT_NAMES = new Set([
  ".babelrc", ".browserslistrc", ".dockerignore", ".editorconfig",
  ".env", ".env.development", ".env.example", ".env.local", ".env.production", ".env.test",
  ".eslintignore", ".eslintrc", ".gitattributes", ".gitignore", ".gitmodules",
  ".htaccess", ".mailmap", ".npmrc", ".nvmrc", ".prettierignore", ".prettierrc",
  ".python-version", ".ruby-version", ".stylelintrc", ".tool-versions",
  ".watchmanconfig", ".yarnrc",
]);

export function isMarkdown(ext: string): boolean {
  return ext === ".md" || ext === ".markdown";
}

export function isText(ext: string): boolean {
  return isMarkdown(ext) || TEXT_EXTS.has(ext) || CODE_EXTS.has(ext);
}

export function isTextName(name: string): boolean {
  return TEXT_NAMES.has(name);
}
