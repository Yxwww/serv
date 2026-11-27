// Pure review-comment state. storage.ts/DOM wiring lives elsewhere.

export const STORAGE_KEY = "serv:review";

export type LineAnchor = {
  kind: "lines";
  start: number;
  end: number;
  quote: string;
  /** Full raw lines start..end; absent on old entries. */
  excerpt?: string;
};
export type QuoteAnchor = {
  kind: "quote";
  quote: string;
  prefix: string;
  suffix: string;
  /** Source lines behind a rendered selection; absent for old entries. */
  lines?: { start: number; end: number };
  /** Raw Markdown for `lines`, so exports can be grepped in the source. */
  excerpt?: string;
};
export type Anchor = LineAnchor | QuoteAnchor;

export interface ReviewComment {
  id: string;
  path: string;
  anchor: Anchor;
  body: string;
  created: number;
}

export interface ReviewState {
  v: 1;
  comments: ReviewComment[];
}

export function emptyState(): ReviewState {
  return { v: 1, comments: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAnchor(value: unknown): Anchor | null {
  if (!isRecord(value)) return null;
  if (value.kind === "lines") {
    if (typeof value.quote !== "string") return null;
    if (typeof value.start !== "number" || !Number.isInteger(value.start)) return null;
    if (typeof value.end !== "number" || !Number.isInteger(value.end)) return null;
    if (value.start < 1 || value.end < value.start) return null;
    const anchor: LineAnchor = {
      kind: "lines",
      start: value.start,
      end: value.end,
      quote: value.quote,
    };
    if (value.excerpt !== undefined) {
      if (typeof value.excerpt !== "string") return null;
      anchor.excerpt = value.excerpt;
    }
    return anchor;
  }
  if (value.kind === "quote") {
    if (typeof value.quote !== "string") return null;
    if (typeof value.prefix !== "string") return null;
    if (typeof value.suffix !== "string") return null;
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: value.quote,
      prefix: value.prefix,
      suffix: value.suffix,
    };
    if (value.lines !== undefined) {
      if (!isRecord(value.lines)) return null;
      if (typeof value.lines.start !== "number" || !Number.isInteger(value.lines.start)) return null;
      if (typeof value.lines.end !== "number" || !Number.isInteger(value.lines.end)) return null;
      if (value.lines.start < 1 || value.lines.end < value.lines.start) return null;
      anchor.lines = { start: value.lines.start, end: value.lines.end };
    }
    if (value.excerpt !== undefined) {
      if (typeof value.excerpt !== "string") return null;
      anchor.excerpt = value.excerpt;
    }
    return anchor;
  }
  return null;
}

function parseComment(value: unknown): ReviewComment | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string") return null;
  if (typeof value.path !== "string") return null;
  if (typeof value.body !== "string") return null;
  if (typeof value.created !== "number" || !Number.isFinite(value.created)) return null;
  const anchor = parseAnchor(value.anchor);
  if (!anchor) return null;
  return { id: value.id, path: value.path, anchor, body: value.body, created: value.created };
}

/** Never throws; anything unrecognizable degrades to an empty state. */
export function parseState(raw: string | null): ReviewState {
  if (raw === null) return emptyState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (!isRecord(parsed) || parsed.v !== 1 || !Array.isArray(parsed.comments)) return emptyState();
  const comments: ReviewComment[] = [];
  for (let i = 0; i < parsed.comments.length; i++) {
    const comment = parseComment(parsed.comments[i]);
    if (comment) comments.push(comment);
  }
  return { v: 1, comments };
}

export function serializeState(s: ReviewState): string {
  return JSON.stringify(s);
}

function cloneAnchor(anchor: Anchor): Anchor {
  if (anchor.kind === "lines") {
    const copy: LineAnchor = {
      kind: "lines",
      start: anchor.start,
      end: anchor.end,
      quote: anchor.quote,
    };
    if (anchor.excerpt !== undefined) copy.excerpt = anchor.excerpt;
    return copy;
  }
  const copy: QuoteAnchor = {
    kind: "quote",
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
  };
  if (anchor.lines !== undefined) copy.lines = { start: anchor.lines.start, end: anchor.lines.end };
  if (anchor.excerpt !== undefined) copy.excerpt = anchor.excerpt;
  return copy;
}

function cloneComment(comment: ReviewComment): ReviewComment {
  return {
    id: comment.id,
    path: comment.path,
    anchor: cloneAnchor(comment.anchor),
    body: comment.body,
    created: comment.created,
  };
}

export function addComment(
  s: ReviewState,
  c: { path: string; anchor: Anchor; body: string },
  id: string,
  now: number,
): ReviewState {
  const comments: ReviewComment[] = [];
  for (let i = 0; i < s.comments.length; i++) comments.push(cloneComment(s.comments[i]));
  comments.push({ id, path: c.path, anchor: cloneAnchor(c.anchor), body: c.body, created: now });
  return { v: 1, comments };
}

export function updateComment(s: ReviewState, id: string, body: string): ReviewState {
  const comments: ReviewComment[] = [];
  for (let i = 0; i < s.comments.length; i++) {
    const comment = s.comments[i];
    if (comment.id !== id) {
      comments.push(cloneComment(comment));
      continue;
    }
    comments.push({
      id: comment.id,
      path: comment.path,
      anchor: cloneAnchor(comment.anchor),
      body,
      created: comment.created,
    });
  }
  return { v: 1, comments };
}

export function removeComment(s: ReviewState, id: string): ReviewState {
  const comments: ReviewComment[] = [];
  for (let i = 0; i < s.comments.length; i++) {
    if (s.comments[i].id !== id) comments.push(cloneComment(s.comments[i]));
  }
  return { v: 1, comments };
}

export function findComment(s: ReviewState, id: string): ReviewComment | undefined {
  for (let i = 0; i < s.comments.length; i++) {
    if (s.comments[i].id === id) return cloneComment(s.comments[i]);
  }
  return undefined;
}

/** First source line behind a comment, or undefined for an unlocatable quote. */
function startLine(comment: ReviewComment): number | undefined {
  if (comment.anchor.kind === "lines") return comment.anchor.start;
  return comment.anchor.lines?.start;
}

function endLine(comment: ReviewComment): number {
  if (comment.anchor.kind === "lines") return comment.anchor.end;
  return comment.anchor.lines?.end ?? 0;
}

/** Line order across anchor kinds; quotes without source lines go last. */
function compareComments(a: ReviewComment, b: ReviewComment): number {
  const aStart = startLine(a);
  const bStart = startLine(b);
  if (aStart === undefined || bStart === undefined) {
    if (aStart !== undefined) return -1;
    if (bStart !== undefined) return 1;
    if (a.created !== b.created) return a.created - b.created;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  if (aStart !== bStart) return aStart - bStart;
  const aEnd = endLine(a);
  const bEnd = endLine(b);
  if (aEnd !== bEnd) return aEnd - bEnd;
  if (a.created !== b.created) return a.created - b.created;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function groupByPath(s: ReviewState, currentPath?: string): { path: string; comments: ReviewComment[] }[] {
  const groups: { path: string; comments: ReviewComment[] }[] = [];
  const byPath = new Map<string, { path: string; comments: ReviewComment[] }>();
  for (let i = 0; i < s.comments.length; i++) {
    const comment = s.comments[i];
    let group = byPath.get(comment.path);
    if (!group) {
      group = { path: comment.path, comments: [] };
      byPath.set(comment.path, group);
      groups.push(group);
    }
    group.comments.push(cloneComment(comment));
  }

  let current: { path: string; comments: ReviewComment[] } | undefined;
  const rest: { path: string; comments: ReviewComment[] }[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    group.comments.sort(compareComments);
    if (currentPath !== undefined && group.path === currentPath) current = group;
    else rest.push(group);
  }
  rest.sort((a, b) => comparePaths(a.path, b.path));
  return current ? [current, ...rest] : rest;
}

/** Char offsets (end exclusive) to 1-based inclusive lines. */
export function lineRangeFromOffsets(text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (from < 0) from = 0;
  if (to < 0) to = 0;
  if (from > text.length) from = text.length;
  if (to > text.length) to = text.length;

  let startLine = 1;
  for (let i = 0; i < from; i++) if (text[i] === "\n") startLine++;
  if (to <= from) return { start: startLine, end: startLine };

  // Last selected character decides the end line, so a selection ending just
  // after "\n" stays on that newline's line instead of the empty next one.
  let endLine = 1;
  for (let i = 0; i < to - 1; i++) if (text[i] === "\n") endLine++;
  return { start: startLine, end: endLine };
}

/** Punctuation that Markdown rendering removes or rewrites. */
function isMarkdownNoise(code: number): boolean {
  if (code <= 32) return true; // whitespace, newlines, tabs
  switch (code) {
    case 33: // !
    case 35: // #
    case 40: // (
    case 41: // )
    case 42: // *
    case 43: // +
    case 45: // -
    case 58: // :
    case 61: // =
    case 62: // >
    case 91: // [
    case 92: // backslash
    case 93: // ]
    case 95: // _
    case 96: // `
    case 124: // |
    case 126: // ~
      return true;
    default:
      return false;
  }
}

/** Last char of a balanced `(...)` run, or the end of the string. */
function skipParens(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 92) {
      i++; // escaped char
      continue;
    }
    if (code === 40) depth++;
    else if (code === 41 && --depth === 0) return i;
  }
  return text.length - 1;
}

/** Last char of an image's `![alt](url)`; alt text is absent from rendered text. */
function skipImage(text: string, bang: number): number {
  let depth = 1;
  let i = bang + 2;
  for (; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 92) {
      i++;
      continue;
    }
    if (code === 91) depth++;
    else if (code === 93 && --depth === 0) break;
  }
  if (i >= text.length) return text.length - 1;
  if (text.charCodeAt(i + 1) === 40) return skipParens(text, i + 1);
  return i;
}

/** Normalized source plus the raw offset of every kept code unit. */
function normalizeSource(source: string): { text: string; map: Int32Array } {
  let text = "";
  const map = new Int32Array(source.length);
  let kept = 0;
  for (let i = 0; i < source.length; i++) {
    const code = source.charCodeAt(i);
    if (code === 33 && source.charCodeAt(i + 1) === 91) {
      i = skipImage(source, i);
      continue;
    }
    if (code === 93 && source.charCodeAt(i + 1) === 40) {
      i = skipParens(source, i + 1);
      continue;
    }
    if (isMarkdownNoise(code)) continue;
    map[kept++] = i;
    text += source[i];
  }
  return { text, map };
}

function normalizeRendered(rendered: string): string {
  let text = "";
  for (let i = 0; i < rendered.length; i++) {
    if (!isMarkdownNoise(rendered.charCodeAt(i))) text += rendered[i];
  }
  return text;
}

/**
 * Map rendered selection text back to the raw Markdown's line range. `hintOffset`
 * is an approximate raw source offset; among equal normalized matches it picks
 * the nearest, which keeps repeated table cells on the right row.
 */
export function mapToSourceLines(
  source: string,
  rendered: string,
  hintOffset?: number,
): { start: number; end: number } | null {
  const needle = normalizeRendered(rendered);
  if (needle === "") return null;
  const normalized = normalizeSource(source);
  const haystack = normalized.text;
  if (haystack === "") return null;

  let index = haystack.indexOf(needle);
  if (index === -1) return null;

  if (hintOffset !== undefined) {
    let best = index;
    let bestDistance = Math.abs(normalized.map[index]! - hintOffset);
    while ((index = haystack.indexOf(needle, index + 1)) !== -1) {
      const distance = Math.abs(normalized.map[index]! - hintOffset);
      if (distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    }
    index = best;
  }

  const start = normalized.map[index]!;
  const end = normalized.map[index + needle.length - 1]! + 1;
  return lineRangeFromOffsets(source, start, end);
}

/** 1-based inclusive lines to char offsets, end excluding the line's "\n". */
export function lineOffsets(text: string, start: number, end: number): { start: number; end: number } {
  let first = start;
  let last = end;
  if (first > last) {
    const swap = first;
    first = last;
    last = swap;
  }
  if (first < 1) first = 1;
  if (last < 1) last = 1;

  let lineCount = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineCount++;
  if (first > lineCount) first = lineCount;
  if (last > lineCount) last = lineCount;

  let startOffset = 0;
  if (first > 1) {
    startOffset = text.length;
    let line = 1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "\n") continue;
      line++;
      if (line === first) {
        startOffset = i + 1;
        break;
      }
    }
  }

  let endOffset = text.length;
  let line = 1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    if (line === last) {
      endOffset = i;
      break;
    }
    line++;
  }
  return { start: startOffset, end: endOffset };
}

export function makeQuoteAnchor(text: string, start: number, end: number, context = 32): QuoteAnchor {
  let from = start;
  let to = end;
  if (from > to) {
    const swap = from;
    from = to;
    to = swap;
  }
  if (from < 0) from = 0;
  if (to < 0) to = 0;
  if (from > text.length) from = text.length;
  if (to > text.length) to = text.length;

  const size = context > 0 ? context : 0;
  const prefixStart = from - size > 0 ? from - size : 0;
  const suffixEnd = to + size < text.length ? to + size : text.length;
  return {
    kind: "quote",
    quote: text.slice(from, to),
    prefix: text.slice(prefixStart, from),
    suffix: text.slice(to, suffixEnd),
  };
}

/** Locate the occurrence whose neighbors best match the anchor's context. */
export function findQuote(text: string, a: QuoteAnchor): { start: number; end: number } | null {
  const quote = a.quote;
  if (quote === "") return null;

  let bestStart = -1;
  let bestScore = -1;
  let index = text.indexOf(quote);
  while (index !== -1) {
    const prefixAvailable = index < a.prefix.length ? index : a.prefix.length;
    let prefixScore = 0;
    while (
      prefixScore < prefixAvailable &&
      text[index - 1 - prefixScore] === a.prefix[a.prefix.length - 1 - prefixScore]
    ) {
      prefixScore++;
    }

    const after = index + quote.length;
    const suffixAvailable = text.length - after < a.suffix.length ? text.length - after : a.suffix.length;
    let suffixScore = 0;
    while (suffixScore < suffixAvailable && text[after + suffixScore] === a.suffix[suffixScore]) {
      suffixScore++;
    }

    // An exact context scores the maximum, so it wins over any partial match.
    const score = prefixScore + suffixScore;
    if (score > bestScore) {
      bestScore = score;
      bestStart = index;
    }
    index = text.indexOf(quote, index + 1);
  }

  return bestStart === -1 ? null : { start: bestStart, end: bestStart + quote.length };
}

const MAX_QUOTE_LINES = 40;
const MAX_SELECTED_CHARS = 200;

function displayPath(path: string): string {
  return path.charCodeAt(0) === 47 ? path.slice(1) : path;
}

function quoteMarkdown(quote: string): string {
  const lines = quote.replace(/\s+$/, "").split("\n");
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.replace(/\s+$/, "");
  const limit = lines.length > MAX_QUOTE_LINES ? MAX_QUOTE_LINES : lines.length;
  const out: string[] = [];
  for (let i = 0; i < limit; i++) out.push(lines[i] === "" ? ">" : "> " + lines[i]);
  if (lines.length > MAX_QUOTE_LINES) out.push(`> … (${lines.length - MAX_QUOTE_LINES} more lines)`);
  return out.join("\n");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function commentBlock(comment: ReviewComment, index: number): string {
  const path = displayPath(comment.path);
  const anchor = comment.anchor;
  const lines = anchor.kind === "lines" ? anchor : anchor.lines;
  let location = `${path} (no line match)`;
  if (lines) {
    location =
      lines.start === lines.end ? `${path}:${lines.start}` : `${path}:${lines.start}-${lines.end}`;
  }
  // Prefer the full source lines; old entries only have the selected text.
  const quote =
    anchor.excerpt !== undefined && anchor.excerpt !== "" ? anchor.excerpt : anchor.quote;
  const selected = collapse(anchor.quote);
  let selectedLine = "";
  if (selected !== "" && selected !== collapse(quote)) {
    const shown = selected.length > MAX_SELECTED_CHARS
      ? selected.slice(0, MAX_SELECTED_CHARS) + "…"
      : selected;
    selectedLine = `\nSelected: "${shown}"`;
  }
  return `### ${index}. ${location}\n${quoteMarkdown(quote)}${selectedLine}\n\n**Comment:** ${comment.body}`;
}

export function toMarkdown(s: ReviewState, date: string, root?: string): string {
  const header = `# Comments — ${date}\n${root === undefined ? "" : `Root: ${root}\n`}\n`;
  const groups = groupByPath(s);
  if (groups.length === 0) return `${header}_No comments._\n`;

  const blocks: string[] = [];
  let index = 0;
  for (let i = 0; i < groups.length; i++) {
    for (let j = 0; j < groups[i].comments.length; j++) {
      blocks.push(commentBlock(groups[i].comments[j]!, ++index));
    }
  }
  return `${header}${blocks.join("\n\n")}\n`;
}
