// Browser side of review comments: selection anchoring, highlights and the bar.
// All persisted state lives in localStorage; there is no server write path.

import { isEditable, resultHref } from "../browser";
import {
  MAX_QUOTE_LINES,
  STORAGE_KEY,
  addComment,
  emptyState,
  findComment,
  findQuote,
  groupByPath,
  lineOffsets,
  lineRangeFromOffsets,
  lineSpan,
  lineStartOffsets,
  makeQuoteAnchor,
  mapToSourceRange,
  parseState,
  removeComment,
  serializeState,
  toMarkdown,
  updateComment,
  type Anchor,
  type ReviewComment,
  type ReviewState,
} from "./model";
import { REVIEW_OPEN_CLASS, REVIEW_OPEN_KEY } from "./keys";

const HIGHLIGHT = "serv-review";
const FLASH_HIGHLIGHT = "serv-review-flash";
const COMMENT_HASH = "#c=";
const MAX_ANCHOR_CHARS = 2000;
const SELECTION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type HighlightsRegistry = Map<string, unknown>;
type HighlightConstructor = new (...ranges: Range[]) => unknown;

type Region = { kind: "source" | "prose"; el: Element };
type Pending = { path: string; anchor: Anchor; rect: DOMRect };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  node.className = className;
  return node;
}

/** UTF-16 offset of a DOM point inside `root`, matching textContent offsets. */
function offsetOf(root: Element, node: Node, offset: number): number {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  try {
    range.setEnd(node, offset);
  } catch {
    return 0;
  }
  return range.toString().length;
}

/** The text-node span for [start, end) character offsets inside `root`. */
function rangeFromOffsets(root: Element, start: number, end: number): Range | null {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let startNode: Text | null = null;
  let endNode: Text | null = null;
  let startOffset = 0;
  let endOffset = 0;
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const length = text.data.length;
    if (!startNode && start <= pos + length) {
      startNode = text;
      startOffset = start - pos;
    }
    if (!endNode && end <= pos + length) {
      endNode = text;
      endOffset = end - pos;
    }
    if (startNode && endNode) break;
    pos += length;
    node = walker.nextNode();
  }
  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, Math.min(startOffset, startNode.data.length));
  range.setEnd(endNode, Math.min(endOffset, endNode.data.length));
  return range;
}

type TextIndex = { text: string; range(start: number, end: number): Range | null };

/** One TreeWalker per root; comment offsets then resolve by binary search. */
function textIndex(root: Element, doc: Document): TextIndex {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    nodes.push(textNode);
    starts.push(text.length);
    text += textNode.data;
    node = walker.nextNode();
  }
  const offsets = Int32Array.from(starts);

  function locate(offset: number): { i: number; off: number } | null {
    if (nodes.length === 0) return null;
    if (offset <= 0) return { i: 0, off: 0 };
    if (offset >= text.length) {
      const i = nodes.length - 1;
      return { i, off: nodes[i]!.data.length };
    }
    let lo = 0;
    let hi = nodes.length - 1;
    let i = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid]! <= offset) {
        i = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { i, off: offset - offsets[i]! };
  }

  return {
    text,
    range(start: number, end: number): Range | null {
      const from = locate(start);
      const to = locate(end);
      if (!from || !to) return null;
      const range = doc.createRange();
      range.setStart(nodes[from.i]!, Math.min(from.off, nodes[from.i]!.data.length));
      range.setEnd(nodes[to.i]!, Math.min(to.off, nodes[to.i]!.data.length));
      return range;
    },
  };
}

function highlightApi(): { registry: HighlightsRegistry; ctor: HighlightConstructor } | null {
  const registry = (CSS as unknown as { highlights?: HighlightsRegistry }).highlights;
  const ctor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && typeof ctor === "function" ? { registry, ctor } : null;
}

export function readState(storage: StorageLike): ReviewState {
  try {
    return parseState(storage.getItem(STORAGE_KEY));
  } catch {
    return emptyState();
  }
}

/** False means the caller must keep its in-memory state unchanged. */
export function writeState(storage: StorageLike, state: ReviewState): boolean {
  try {
    storage.setItem(STORAGE_KEY, serializeState(state));
    return true;
  } catch {
    return false;
  }
}

export function rootPath(doc: Document): string {
  return doc.body.dataset.servRoot ?? "";
}

export function commentIdFromHash(hash: string): string | null {
  if (!hash.startsWith(COMMENT_HASH)) return null;
  const raw = hash.slice(COMMENT_HASH.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function commentHref(path: string, id: string): string {
  return resultHref(path) + COMMENT_HASH + encodeURIComponent(id);
}

function capChars(text: string): string {
  if (text.length <= MAX_ANCHOR_CHARS) return text;
  let end = MAX_ANCHOR_CHARS;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--; // don't split a surrogate pair
  return text.slice(0, end);
}

function capLines(text: string): string {
  const lines = text.split("\n");
  return lines.length > MAX_QUOTE_LINES ? lines.slice(0, MAX_QUOTE_LINES).join("\n") : text;
}

function capExcerpt(text: string): string {
  return capChars(capLines(text));
}

export type SelectionAnchorInput = {
  kind: "source" | "prose";
  text: string;
  start: number;
  end: number;
  source?: string;
  hint?: number;
};

/** Anchor creation from offsets; Range/TreeWalker only supplies `start`/`end`. */
export function anchorFromSelection(input: SelectionAnchorInput): Anchor | null {
  const quote = input.text.slice(input.start, input.end);
  if (quote.trim() === "") return null;

  if (input.kind === "source") {
    const selected = capChars(quote);
    const lines = lineRangeFromOffsets(input.text, input.start, input.end);
    const span = lineOffsets(input.text, lines.start, lines.end);
    return {
      kind: "lines",
      start: lines.start,
      end: lines.end,
      quote: selected,
      excerpt: capExcerpt(input.text.slice(span.start, span.end)),
      selected,
    };
  }

  const anchor = makeQuoteAnchor(input.text, input.start, input.end);
  anchor.quote = capChars(anchor.quote);
  if (input.source) {
    // Match the uncapped rendered text against the raw Markdown first.
    const mapped = mapToSourceRange(input.source, quote, input.hint);
    if (mapped) {
      anchor.lines = mapped.lines;
      const span = lineOffsets(input.source, mapped.lines.start, mapped.lines.end);
      anchor.excerpt = capExcerpt(input.source.slice(span.start, span.end));
      anchor.selected = capChars(input.source.slice(mapped.start, mapped.end));
    }
  }
  return anchor;
}

function newId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

function today(): string {
  const date = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function quoteExcerpt(quote: string): string {
  const one = quote.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 119) + "…" : one;
}

function locationLabel(comment: ReviewComment): string {
  const anchor = comment.anchor;
  const lines = anchor.kind === "lines" ? anchor : anchor.lines;
  if (!lines) return "quote";
  return lines.start === lines.end ? `L${lines.start}` : `L${lines.start}-${lines.end}`;
}

async function copyText(
  doc: Document,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
  text: string,
): Promise<boolean> {
  if (clipboard) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard permission or focus may be unavailable; fall back once.
    }
  }
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  doc.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = doc.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function browserStorage(): StorageLike {
  try {
    return globalThis.localStorage;
  } catch {
    return {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
  }
}

function browserClipboard(): Pick<Clipboard, "writeText"> | undefined {
  try {
    return globalThis.navigator?.clipboard;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

export function initReview(
  doc: Document = globalThis.document,
  storage: StorageLike = browserStorage(),
  clipboard: Pick<Clipboard, "writeText"> | undefined = browserClipboard(),
): void {
  const document = doc;
  const toggleBtn = document.getElementById("serv-review-toggle");
  const bar = document.getElementById("serv-review-bar");
  const list = bar?.querySelector<HTMLElement>("[data-review-list]");
  const copyBtn = bar?.querySelector<HTMLButtonElement>("[data-review-copy]");
  const clearBtn = bar?.querySelector<HTMLButtonElement>("[data-review-clear]");
  const totalEl = bar?.querySelector<HTMLElement>("[data-review-total]");
  const copyStatus = bar?.querySelector<HTMLElement>("[data-review-status]");
  const title = bar?.querySelector<HTMLElement>(".review-title");
  const badge = toggleBtn?.querySelector<HTMLElement>("[data-review-badge]");
  if (!toggleBtn || !bar || !list || !copyBtn || !clearBtn || !totalEl || !copyStatus || !title || !badge) {
    return;
  }

  let state: ReviewState = readState(storage);
  const missing = new Set<string>();
  const app = document.querySelector<HTMLElement>(".app");
  const narrow = window.matchMedia("(max-width: 799.98px)");
  let copyStatusTimer = 0;
  const saveHint = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";

  const addButton = make(document, "button", "review-add");
  addButton.type = "button";
  addButton.hidden = true;
  addButton.textContent = "Comment";

  const composer = make(document, "div", "review-composer");
  composer.hidden = true;
  composer.setAttribute("role", "dialog");
  composer.setAttribute("aria-label", "Add comment");
  const composerInput = make(document, "textarea", "review-input");
  composerInput.rows = 3;
  composerInput.placeholder = "Write a comment…";
  composerInput.setAttribute("aria-label", "Comment");
  const composerFoot = make(document, "div", "review-composer-foot");
  const composerHint = make(document, "span", "review-hint");
  composerHint.id = "serv-review-composer-hint";
  composerHint.textContent = `${saveHint} save · Esc cancel`;
  composer.setAttribute("aria-describedby", composerHint.id);
  const composerCancel = make(document, "button", "review-btn");
  composerCancel.type = "button";
  composerCancel.textContent = "Cancel";
  const composerSave = make(document, "button", "review-btn review-btn-primary");
  composerSave.type = "button";
  composerSave.textContent = "Comment";
  composerSave.disabled = true;
  const composerError = make(document, "p", "review-error");
  composerError.hidden = true;
  composerError.setAttribute("role", "alert");
  composerFoot.append(composerHint, composerCancel, composerSave);
  composer.append(composerInput, composerError, composerFoot);
  document.body.append(addButton, composer);

  let pending: Pending | null = null;
  let flashTimer = 0;
  let selectionRaf = 0;
  let keyboardSelection = false;

  // -- open state -----------------------------------------------------------

  function isOpen(): boolean {
    return document.documentElement.classList.contains(REVIEW_OPEN_CLASS);
  }

  function syncBar(): void {
    const open = isOpen();
    toggleBtn!.setAttribute("aria-expanded", String(open));
    if (open) bar!.removeAttribute("inert");
    else bar!.setAttribute("inert", "");
    // Below 800px the backdrop covers the page; keep keyboard and AT out of it.
    if (app) app.inert = open && narrow.matches;
  }

  function setOpen(open: boolean, persist: boolean, moveFocus = true): void {
    const wasOpen = isOpen();
    document.documentElement.classList.toggle(REVIEW_OPEN_CLASS, open);
    syncBar();
    if (persist) {
      try {
        storage.setItem(REVIEW_OPEN_KEY, open ? "1" : "0");
      } catch {
        // The class still applies for this page.
      }
    }
    if (!moveFocus || open === wasOpen) return;
    if (open) {
      requestAnimationFrame(() => {
        if (isOpen()) title!.focus();
      });
    } else {
      toggleBtn!.focus();
    }
  }

  // -- page and mode --------------------------------------------------------

  function currentPath(): string {
    try {
      return decodeURIComponent(location.pathname);
    } catch {
      return location.pathname;
    }
  }

  function isMarkdownPage(): boolean {
    return document.querySelector("[data-md-view]") !== null;
  }

  function isSourceMode(): boolean {
    return !isMarkdownPage() || document.documentElement.classList.contains("serv-md-source");
  }

  function sourceCode(): Element | null {
    const md = document.querySelector("[data-md-view]");
    if (md) return md.querySelector('[data-md-panel="source"] .source .code code');
    return document.querySelector(".source .code code");
  }

  function proseRoot(): Element | null {
    const md = document.querySelector("[data-md-view]");
    return md ? md.querySelector('[data-md-panel="rendered"] .markdown.prose') : null;
  }

  function region(): Region | null {
    const md = document.querySelector("[data-md-view]");
    if (md) {
      if (isSourceMode()) {
        const el = sourceCode();
        return el ? { kind: "source", el } : null;
      }
      const el = proseRoot();
      return el ? { kind: "prose", el } : null;
    }
    const el = sourceCode();
    return el ? { kind: "source", el } : null;
  }

  function ensureMode(mode: "source" | "rendered"): void {
    const md = document.querySelector("[data-md-view]");
    if (!md) return;
    const wantSource = mode === "source";
    if (document.documentElement.classList.contains("serv-md-source") === wantSource) return;
    const link = document.querySelector<HTMLElement>(`[data-md-link="${mode}"]`);
    if (link) {
      link.click();
      return;
    }
    document.documentElement.classList.toggle("serv-md-source", wantSource);
    document.documentElement.classList.toggle("serv-md-rendered", !wantSource);
  }

  /** A Range for the comment on the current page, or null when it cannot map. */
  function resolveRange(comment: ReviewComment, navigate: boolean): Range | null {
    const md = isMarkdownPage();
    if (comment.anchor.kind === "lines") {
      // A line anchor only exists in the source panel; switching is navigation only.
      if (md && !isSourceMode()) {
        if (!navigate) return null;
        ensureMode("source");
      }
      const code = sourceCode();
      if (!code) return null;
      const text = code.textContent ?? "";
      const span = lineOffsets(text, comment.anchor.start, comment.anchor.end);
      return rangeFromOffsets(code, span.start, span.end);
    }

    const anchor = comment.anchor;
    if (md) {
      if (isSourceMode()) {
        if (navigate) ensureMode("rendered");
        const target = navigate ? proseRoot() : sourceCode();
        const text = target?.textContent ?? "";
        const found = findQuote(text, anchor);
        return target && found ? rangeFromOffsets(target, found.start, found.end) : null;
      }
      const prose = proseRoot();
      const text = prose?.textContent ?? "";
      const found = findQuote(text, anchor);
      if (prose && found) return rangeFromOffsets(prose, found.start, found.end);
      if (navigate) {
        // Rendered text drifted; the raw source may still hold the quote.
        const code = sourceCode();
        const raw = code?.textContent ?? "";
        const rawFound = findQuote(raw, anchor);
        if (code && rawFound) {
          ensureMode("source");
          return rangeFromOffsets(code, rawFound.start, rawFound.end);
        }
      }
      return null;
    }

    const code = sourceCode();
    const text = code?.textContent ?? "";
    const found = findQuote(text, anchor);
    return code && found ? rangeFromOffsets(code, found.start, found.end) : null;
  }

  // -- highlights -----------------------------------------------------------

  function refreshHighlights(): void {
    const api = highlightApi();
    if (!api) return;
    const path = currentPath();
    const active = region();
    if (!active) {
      api.registry.delete(HIGHLIGHT);
      return;
    }
    const index = textIndex(active.el, document);
    const starts = active.kind === "source" ? lineStartOffsets(index.text) : null;
    const ranges: Range[] = [];
    for (const comment of state.comments) {
      if (comment.path !== path) continue;
      const anchor = comment.anchor;
      if (active.kind === "source") {
        const lines = anchor.kind === "lines" ? anchor : anchor.lines;
        if (lines && starts) {
          const span = lineSpan(starts, index.text.length, lines.start, lines.end);
          const range = index.range(span.start, span.end);
          if (range) ranges.push(range);
        } else if (anchor.kind === "quote") {
          const found = findQuote(index.text, anchor);
          if (found) {
            const range = index.range(found.start, found.end);
            if (range) ranges.push(range);
          }
        }
        continue;
      }
      // Rendered preview: only quote anchors exist as text there.
      if (anchor.kind !== "quote") continue;
      const found = findQuote(index.text, anchor);
      if (found) {
        const range = index.range(found.start, found.end);
        if (range) ranges.push(range);
      }
    }
    if (ranges.length > 0) api.registry.set(HIGHLIGHT, new api.ctor(...ranges));
    else api.registry.delete(HIGHLIGHT);
  }

  function flash(range: Range): void {
    const api = highlightApi();
    if (!api) return;
    api.registry.set(FLASH_HIGHLIGHT, new api.ctor(range));
    clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => api.registry.delete(FLASH_HIGHLIGHT), 1400);
  }

  // -- bar ------------------------------------------------------------------

  function updateChrome(): void {
    const total = state.comments.length;
    totalEl!.textContent = String(total);
    badge!.textContent = String(total);
    badge!.hidden = total === 0;
    toggleBtn!.title = total > 0 ? `Comments (${total})` : "Comments";
    toggleBtn!.setAttribute("aria-label", total > 0 ? `Comments (${total})` : "Comments");
    clearBtn!.disabled = total === 0;
    copyBtn!.disabled = total === 0;
  }

  function renderItem(comment: ReviewComment): HTMLLIElement {
    const item = make(document, "li", "review-item");
    item.dataset.id = comment.id;

    const jump = make(document, "a", "review-jump");
    jump.href = commentHref(comment.path, comment.id);
    if (comment.path === currentPath()) jump.title = "Go to this comment";

    const head = make(document, "div", "review-item-head");
    const loc = make(document, "span", "review-loc");
    loc.textContent = locationLabel(comment);
    head.append(loc);
    if (missing.has(comment.id)) {
      const note = make(document, "span", "review-missing");
      note.textContent = "couldn't locate";
      head.append(note);
    }
    jump.append(head);

    const excerpt = quoteExcerpt(comment.anchor.quote);
    if (excerpt) {
      const quote = make(document, "p", "review-quote");
      quote.textContent = excerpt;
      jump.append(quote);
    }
    item.append(jump);

    const body = make(document, "p", "review-body");
    body.textContent = comment.body;
    item.append(body);

    const actions = make(document, "div", "review-item-actions");
    const edit = make(document, "button", "review-item-action");
    edit.type = "button";
    edit.dataset.reviewEdit = "";
    edit.textContent = "Edit";
    const remove = make(document, "button", "review-item-action");
    remove.type = "button";
    remove.dataset.reviewDelete = "";
    remove.textContent = "Delete";
    actions.append(edit, remove);
    item.append(actions);
    return item;
  }

  function renderList(): void {
    list!.textContent = "";
    const groups = groupByPath(state, currentPath());
    if (groups.length === 0) {
      const empty = make(document, "p", "review-empty");
      empty.textContent = region()
        ? "No comments yet. Select text in a file, then choose Comment."
        : "Open a file to select text and add a comment.";
      list!.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    const path = currentPath();
    for (const group of groups) {
      const section = make(document, "section", "review-group");
      const heading = make(document, "h3", "review-group-path");
      heading.textContent = group.path.replace(/^\//, "") || group.path;
      heading.title = group.path;
      if (group.path === path) heading.classList.add("is-current");
      const items = make(document, "ul", "review-items");
      for (const comment of group.comments) items.append(renderItem(comment));
      section.append(heading, items);
      fragment.append(section);
    }
    list!.append(fragment);
  }

  function renderAll(): void {
    updateChrome();
    renderList();
    refreshHighlights();
  }

  function goTo(id: string): void {
    const comment = findComment(state, id);
    if (!comment) return;
    if (comment.path === currentPath()) {
      // replaceState changes the hash without a hashchange event, so the item
      // click does not locate the same comment twice.
      try {
        history.replaceState(null, "", COMMENT_HASH + encodeURIComponent(id));
      } catch {
        // A restricted history still gets the scroll and flash.
      }
      locateAndFlash(comment);
      return;
    }
    location.href = commentHref(comment.path, id);
  }

  /** Center a range, scrolling the source box first and then the page. */
  function scrollRangeIntoView(range: Range): void {
    const node = range.startContainer;
    const start = node.nodeType === 1 ? (node as Element) : node.parentElement;
    const scroller = start?.closest(".source");
    if (scroller) {
      // scrollIntoView on a bare text node centers the whole <code> block, so
      // move the line-numbered box from the range's own rect instead.
      const rect = range.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      scroller.scrollTop += rect.top - box.top - scroller.clientHeight / 2 + rect.height / 2;
    }
    const rect = range.getBoundingClientRect();
    const center = rect.top + rect.height / 2;
    if (center < 0 || center > window.innerHeight) {
      window.scrollTo(0, window.scrollY + center - window.innerHeight / 2);
    }
  }

  function locateAndFlash(comment: ReviewComment): void {
    const range = resolveRange(comment, true);
    if (!range) {
      missing.add(comment.id);
      renderList();
      return;
    }
    missing.delete(comment.id);
    scrollRangeIntoView(range);
    flash(range);
    renderList();
  }

  function startEdit(item: HTMLElement, id: string): void {
    if (item.querySelector(".review-edit")) return;
    const comment = findComment(state, id);
    if (!comment) return;

    const editor = make(document, "div", "review-edit");
    const input = make(document, "textarea", "review-input");
    input.rows = 3;
    input.value = comment.body;
    input.setAttribute("aria-label", "Edit comment");
    const foot = make(document, "div", "review-composer-foot");
    const hint = make(document, "span", "review-hint");
    hint.textContent = `${saveHint} save · Esc cancel`;
    const cancel = make(document, "button", "review-btn");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = make(document, "button", "review-btn review-btn-primary");
    save.type = "button";
    save.textContent = "Save";
    save.disabled = comment.body.trim() === "";
    const error = make(document, "p", "review-error");
    error.hidden = true;
    error.setAttribute("role", "alert");
    foot.append(hint, cancel, save);
    editor.append(input, error, foot);

    const body = item.querySelector(".review-body");
    if (body) body.replaceWith(editor);
    else item.append(editor);

    function finish(): void {
      const next = input.value.trim();
      if (next === "") return;
      const nextState = updateComment(state, id, next);
      if (!writeState(storage, nextState)) {
        error.textContent = "Could not save. Browser storage is full or blocked.";
        error.hidden = false;
        return;
      }
      state = nextState;
      renderAll();
    }

    input.addEventListener("input", () => {
      save.disabled = input.value.trim() === "";
    });
    save.addEventListener("click", finish);
    cancel.addEventListener("click", () => renderAll());
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        renderAll();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !save.disabled) {
        event.preventDefault();
        finish();
      }
    });
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function deleteComment(id: string): void {
    const next = removeComment(state, id);
    if (!writeState(storage, next)) return;
    state = next;
    missing.delete(id);
    renderAll();
  }

  // -- selection and composer ----------------------------------------------

  function hideAddButton(): void {
    addButton.hidden = true;
    keyboardSelection = false;
    if (composer.hidden) pending = null;
  }

  function positionAddButton(rect: DOMRect): void {
    const width = addButton.offsetWidth;
    const height = addButton.offsetHeight;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - height - 8);

    // An off-screen selection pins the button to the nearest visible edge.
    let left: number;
    if (rect.right < 0) left = 8;
    else if (rect.left > window.innerWidth) left = maxLeft;
    else {
      left = rect.right - width;
      if (left < 8) left = 8;
      if (left > maxLeft) left = maxLeft;
    }

    let top: number;
    if (rect.bottom < 0) top = 8;
    else if (rect.top > window.innerHeight) top = maxTop;
    else {
      top = rect.bottom + 6;
      if (top > maxTop) top = rect.top - height - 6;
      if (top < 8) top = 8;
      if (top > maxTop) top = maxTop;
    }

    addButton.style.left = `${left}px`;
    addButton.style.top = `${top}px`;
  }

  function positionComposer(rect: DOMRect): void {
    const width = composer.offsetWidth;
    const height = composer.offsetHeight;
    const maxLeft = Math.max(8, window.innerWidth - width - 8);
    const maxTop = Math.max(8, window.innerHeight - height - 8);

    // A pinned button can be opened while its selection is off-screen; keep
    // the composer itself visible in that case too.
    let left: number;
    if (rect.right < 0) left = 8;
    else if (rect.left > window.innerWidth) left = maxLeft;
    else {
      left = rect.left;
      if (left < 8) left = 8;
      if (left > maxLeft) left = maxLeft;
    }

    let top: number;
    if (rect.bottom < 0) top = 8;
    else if (rect.top > window.innerHeight) top = maxTop;
    else {
      top = rect.bottom + 8;
      if (top > maxTop) top = rect.top - height - 8;
      if (top < 8) top = 8;
      if (top > maxTop) top = maxTop;
    }

    composer.style.left = `${left}px`;
    composer.style.top = `${top}px`;
  }

  /** Offsets and anchor only pay for the region text when the button is used. */
  function anchorFromRange(target: Region, range: Range): Anchor | null {
    const text = target.el.textContent ?? "";
    const start = offsetOf(target.el, range.startContainer, range.startOffset);
    const end = offsetOf(target.el, range.endContainer, range.endOffset);
    if (end <= start) return null;
    // A rendered selection maps back to raw Markdown so exports can carry real
    // line numbers and a greppable excerpt.
    const source = target.kind === "prose" ? sourceCode()?.textContent : undefined;
    const hint =
      source && text.length > 0 ? Math.floor((start / text.length) * source.length) : undefined;
    return anchorFromSelection({ kind: target.kind, text, start, end, source, hint });
  }

  /** Selection changes are frequent; only the rect and a cheap containment test. */
  function updateSelection(): void {
    if (!composer.hidden) return;
    if (isEditable(document.activeElement)) {
      hideAddButton();
      return;
    }
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideAddButton();
      return;
    }
    const range = selection.getRangeAt(0);
    if (isEditable(range.startContainer) || isEditable(range.endContainer)) {
      hideAddButton();
      return;
    }
    const target = region();
    if (!target) {
      hideAddButton();
      return;
    }
    if (!target.el.contains(range.startContainer) || !target.el.contains(range.endContainer)) {
      hideAddButton();
      return;
    }
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      hideAddButton();
      return;
    }
    pending = null;
    addButton.hidden = false;
    positionAddButton(rect);
    if (keyboardSelection) {
      // Keep the selection and let Enter open the composer.
      keyboardSelection = false;
      addButton.focus({ preventScroll: true });
    }
  }

  function scheduleSelection(): void {
    if (selectionRaf) return;
    selectionRaf = requestAnimationFrame(() => {
      selectionRaf = 0;
      updateSelection();
    });
  }

  function openComposer(): void {
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideAddButton();
      return;
    }
    const range = selection.getRangeAt(0);
    const target = region();
    if (
      !target ||
      !target.el.contains(range.startContainer) ||
      !target.el.contains(range.endContainer)
    ) {
      hideAddButton();
      return;
    }
    const anchor = anchorFromRange(target, range);
    if (!anchor) {
      hideAddButton();
      return;
    }
    pending = { path: currentPath(), anchor, rect: range.getBoundingClientRect() };
    composerInput.value = "";
    composerSave.disabled = true;
    composerError.hidden = true;
    composer.hidden = false;
    addButton.hidden = true;
    positionComposer(pending.rect);
    composerInput.focus();
  }

  function closeComposer(): void {
    composer.hidden = true;
    composerInput.value = "";
    composerError.hidden = true;
    pending = null;
    document.getSelection()?.removeAllRanges();
  }

  function saveComment(): void {
    if (!pending) return;
    const body = composerInput.value.trim();
    if (body === "") return;
    const next = addComment(
      state,
      { path: pending.path, anchor: pending.anchor, body },
      newId(),
      Date.now(),
    );
    if (!writeState(storage, next)) {
      composerError.textContent = "Could not save. Browser storage is full or blocked.";
      composerError.hidden = false;
      return;
    }
    state = next;
    closeComposer();
    renderAll();
  }

  // -- hash navigation ------------------------------------------------------

  function handleHash(): void {
    const id = commentIdFromHash(location.hash);
    if (!id) return;
    const comment = findComment(state, id);
    if (!comment || comment.path !== currentPath()) return;
    locateAndFlash(comment);
  }

  // -- events ---------------------------------------------------------------

  toggleBtn.addEventListener("click", () => setOpen(!isOpen(), true));
  for (const close of document.querySelectorAll("[data-review-close]")) {
    close.addEventListener("click", () => setOpen(false, true));
  }
  bar.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key !== "Escape" || !composer.hidden || bar!.querySelector(".review-edit")) return;
    event.preventDefault();
    setOpen(false, true);
  });

  copyBtn.addEventListener("click", () => {
    const root = rootPath(document);
    void copyText(document, clipboard, toMarkdown(state, today(), root === "" ? undefined : root)).then((ok) => {
      copyStatus.textContent = ok ? "Comments copied" : "Could not copy comments";
      clearTimeout(copyStatusTimer);
      copyStatusTimer = window.setTimeout(() => {
        copyStatus.textContent = "";
      }, 2000);
    });
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all comments?")) return;
    const next = emptyState();
    if (!writeState(storage, next)) return;
    state = next;
    missing.clear();
    renderAll();
  });

  list.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const item = target.closest<HTMLElement>(".review-item");
    if (!item) return;
    const id = item.dataset.id;
    if (!id) return;
    // The jump target is a real link; let the browser navigate it.
    if (target.closest(".review-jump")) return;
    if (target.closest("[data-review-edit]")) {
      startEdit(item, id);
      return;
    }
    if (target.closest("[data-review-delete]")) {
      deleteComment(id);
      return;
    }
    if (target.closest(".review-edit")) return;
    goTo(id);
  });

  document.addEventListener("keydown", (event) => {
    if (!composer.hidden || isEditable(event.target) || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && SELECTION_KEYS.has(event.key)) keyboardSelection = true;
  });
  document.addEventListener("mousedown", () => { keyboardSelection = false; }, true);
  narrow.addEventListener("change", () => {
    syncBar();
    if (isOpen() && narrow.matches && !bar!.contains(document.activeElement)) title!.focus();
  });

  addButton.addEventListener("mousedown", (event) => event.preventDefault());
  addButton.addEventListener("click", openComposer);

  composerInput.addEventListener("input", () => {
    composerSave.disabled = composerInput.value.trim() === "";
    composerError.hidden = true;
  });
  composerSave.addEventListener("click", saveComment);
  composerCancel.addEventListener("click", closeComposer);
  composerInput.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composerSave.disabled) {
      event.preventDefault();
      saveComment();
    }
  });

  document.addEventListener("selectionchange", scheduleSelection);
  const reposition = (): void => {
    if (composer.hidden) scheduleSelection();
  };
  window.addEventListener("scroll", reposition, true);
  window.addEventListener("resize", reposition);

  // Mode changes move the commentable region; refresh both highlights and the
  // floating button after the toggle's own handler has flipped the panels.
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest("[data-md-link]");
    if (!link) return;
    hideAddButton();
    requestAnimationFrame(refreshHighlights);
  });

  window.addEventListener("hashchange", handleHash);

  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      state = readState(storage);
      renderAll();
      handleHash();
      return;
    }
    if (event.key === REVIEW_OPEN_KEY) setOpen(event.newValue === "1", false, false);
  });

  // -- start ----------------------------------------------------------------

  syncBar();
  renderAll();
  requestAnimationFrame(() => requestAnimationFrame(handleHash));
}

if (typeof document !== "undefined") initReview();
