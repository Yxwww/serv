// Pure review-comment state. storage.ts/DOM wiring lives elsewhere.

export const STORAGE_KEY = "serv:review";

export type LineAnchor = { kind: "lines"; start: number; end: number; quote: string };
export type QuoteAnchor = { kind: "quote"; quote: string; prefix: string; suffix: string };
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
    return { kind: "lines", start: value.start, end: value.end, quote: value.quote };
  }
  if (value.kind === "quote") {
    if (typeof value.quote !== "string") return null;
    if (typeof value.prefix !== "string") return null;
    if (typeof value.suffix !== "string") return null;
    return { kind: "quote", quote: value.quote, prefix: value.prefix, suffix: value.suffix };
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
    return { kind: "lines", start: anchor.start, end: anchor.end, quote: anchor.quote };
  }
  return { kind: "quote", quote: anchor.quote, prefix: anchor.prefix, suffix: anchor.suffix };
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

function compareComments(a: ReviewComment, b: ReviewComment): number {
  if (a.anchor.kind === "lines") {
    if (b.anchor.kind !== "lines") return -1;
    if (a.anchor.start !== b.anchor.start) return a.anchor.start - b.anchor.start;
    if (a.anchor.end !== b.anchor.end) return a.anchor.end - b.anchor.end;
    return a.created - b.created;
  }
  if (b.anchor.kind === "lines") return 1;
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

const MAX_QUOTE_LINES = 20;

function displayPath(path: string): string {
  return path.charCodeAt(0) === 47 ? path.slice(1) : path;
}

function quoteMarkdown(quote: string): string {
  const trimmed = quote.replace(/\s+$/, "");
  const lines = trimmed.split("\n");
  const limit = lines.length > MAX_QUOTE_LINES ? MAX_QUOTE_LINES : lines.length;
  const out: string[] = [];
  for (let i = 0; i < limit; i++) out.push(lines[i] === "" ? ">" : "> " + lines[i]);
  if (lines.length > MAX_QUOTE_LINES) out.push("> …");
  return out.join("\n");
}

function commentBlock(comment: ReviewComment): string {
  const path = displayPath(comment.path);
  let heading = path;
  if (comment.anchor.kind === "lines") {
    heading =
      comment.anchor.start === comment.anchor.end
        ? `${path}:${comment.anchor.start}`
        : `${path}:${comment.anchor.start}-${comment.anchor.end}`;
  }
  return `## ${heading}\n${quoteMarkdown(comment.anchor.quote)}\n\n${comment.body}`;
}

export function toMarkdown(s: ReviewState, date: string): string {
  const groups = groupByPath(s);
  const header = `# Review — ${date}\n\n`;
  if (groups.length === 0) return `${header}_No comments._\n`;

  const blocks: string[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = 0; j < groups[i].comments.length; j++) {
      blocks.push(commentBlock(groups[i].comments[j]));
    }
  }
  return header + blocks.join("\n\n") + "\n";
}
