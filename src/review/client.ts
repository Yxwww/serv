// Browser side of review comments: selection anchoring, highlights and the bar.
// All persisted state lives in localStorage; there is no server write path.

import {
  STORAGE_KEY,
  addComment,
  emptyState,
  findComment,
  findQuote,
  groupByPath,
  lineOffsets,
  lineRangeFromOffsets,
  makeQuoteAnchor,
  mapToSourceLines,
  parseState,
  removeComment,
  serializeState,
  toMarkdown,
  updateComment,
  type Anchor,
  type ReviewComment,
  type ReviewState,
} from "./model";

const OPEN_KEY = "serv:review:open";
const HIGHLIGHT = "serv-review";
const FLASH_HIGHLIGHT = "serv-review-flash";
const COMMENT_HASH = "#c=";

type HighlightsRegistry = Map<string, unknown>;
type HighlightConstructor = new (...ranges: Range[]) => unknown;

type Region = { kind: "source" | "prose"; el: Element };
type Pending = { path: string; anchor: Anchor; rect: DOMRect };

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
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

function highlightApi(): { registry: HighlightsRegistry; ctor: HighlightConstructor } | null {
  const registry = (CSS as unknown as { highlights?: HighlightsRegistry }).highlights;
  const ctor = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight;
  return registry && typeof ctor === "function" ? { registry, ctor } : null;
}

function isEditableNode(node: Node | null): boolean {
  if (!node) return false;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (element as HTMLElement).isContentEditable;
}

function encodeHref(path: string): string {
  return "/" + path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
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
  if (anchor.kind === "lines") {
    return anchor.start === anchor.end ? `:${anchor.start}` : `:${anchor.start}-${anchor.end}`;
  }
  if (anchor.lines) {
    return anchor.lines.start === anchor.lines.end
      ? `L${anchor.lines.start}`
      : `L${anchor.lines.start}-${anchor.lines.end}`;
  }
  return "quote";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard permission or focus may be unavailable; fall back once.
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

function initReview(): void {
  const toggleBtn = document.getElementById("serv-review-toggle");
  const bar = document.getElementById("serv-review-bar");
  const list = bar?.querySelector<HTMLElement>("[data-review-list]");
  const copyBtn = bar?.querySelector<HTMLButtonElement>("[data-review-copy]");
  const clearBtn = bar?.querySelector<HTMLButtonElement>("[data-review-clear]");
  const totalEl = bar?.querySelector<HTMLElement>("[data-review-total]");
  const badge = toggleBtn?.querySelector<HTMLElement>("[data-review-badge]");
  if (!toggleBtn || !bar || !list || !copyBtn || !clearBtn || !totalEl || !badge) return;

  let state: ReviewState = readState();
  const missing = new Set<string>();
  const saveHint = /Mac|iPhone|iPad|iPod/i.test(navigator.userAgent) ? "⌘↵" : "Ctrl+↵";

  const addButton = make("button", "review-add");
  addButton.type = "button";
  addButton.hidden = true;
  addButton.textContent = "Comment";

  const composer = make("div", "review-composer");
  composer.hidden = true;
  const composerInput = make("textarea", "review-input");
  composerInput.rows = 3;
  composerInput.placeholder = "Write a comment…";
  composerInput.setAttribute("aria-label", "Comment");
  const composerFoot = make("div", "review-composer-foot");
  const composerHint = make("span", "review-hint");
  composerHint.textContent = `${saveHint} save · Esc cancel`;
  const composerCancel = make("button", "review-btn");
  composerCancel.type = "button";
  composerCancel.textContent = "Cancel";
  const composerSave = make("button", "review-btn review-btn-primary");
  composerSave.type = "button";
  composerSave.textContent = "Comment";
  composerSave.disabled = true;
  composerFoot.append(composerHint, composerCancel, composerSave);
  composer.append(composerInput, composerFoot);
  document.body.append(addButton, composer);

  let pending: Pending | null = null;
  let flashTimer = 0;
  let selectionRaf = 0;

  // -- state persistence ----------------------------------------------------

  function readState(): ReviewState {
    try {
      return parseState(localStorage.getItem(STORAGE_KEY));
    } catch {
      return emptyState();
    }
  }

  function writeState(): void {
    try {
      localStorage.setItem(STORAGE_KEY, serializeState(state));
    } catch {
      // Private mode or a full quota: comments still work for this page.
    }
  }

  // -- open state -----------------------------------------------------------

  function isOpen(): boolean {
    return document.documentElement.classList.contains("review-open");
  }

  function syncBar(): void {
    const open = isOpen();
    toggleBtn!.setAttribute("aria-expanded", String(open));
    if (open) bar!.removeAttribute("inert");
    else bar!.setAttribute("inert", "");
  }

  function setOpen(open: boolean, persist: boolean): void {
    document.documentElement.classList.toggle("review-open", open);
    syncBar();
    if (!persist) return;
    try {
      localStorage.setItem(OPEN_KEY, open ? "1" : "0");
    } catch {
      // The class still applies for this page.
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

  function rootPath(): string {
    return document.body.dataset.servRoot ?? "";
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
    const ranges: Range[] = [];
    for (const comment of state.comments) {
      if (comment.path !== path) continue;
      const range = resolveRange(comment, false);
      if (range) ranges.push(range);
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
  }

  function renderItem(comment: ReviewComment): HTMLLIElement {
    const item = make("li", "review-item");
    item.dataset.id = comment.id;
    if (comment.path === currentPath()) item.title = "Go to this comment";

    const head = make("div", "review-item-head");
    const loc = make("span", "review-loc");
    loc.textContent = locationLabel(comment);
    head.append(loc);
    if (missing.has(comment.id)) {
      const note = make("span", "review-missing");
      note.textContent = "couldn't locate";
      head.append(note);
    }
    item.append(head);

    const excerpt = quoteExcerpt(comment.anchor.quote);
    if (excerpt) {
      const quote = make("p", "review-quote");
      quote.textContent = excerpt;
      item.append(quote);
    }

    const body = make("p", "review-body");
    body.textContent = comment.body;
    item.append(body);

    const actions = make("div", "review-item-actions");
    const edit = make("button", "review-item-action");
    edit.type = "button";
    edit.dataset.reviewEdit = "";
    edit.textContent = "Edit";
    const remove = make("button", "review-item-action");
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
      const empty = make("p", "review-empty");
      empty.textContent = "No comments yet. Select text in a file, then choose Comment.";
      list!.append(empty);
      return;
    }
    const fragment = document.createDocumentFragment();
    const path = currentPath();
    for (const group of groups) {
      const section = make("section", "review-group");
      const heading = make("h3", "review-group-path");
      heading.textContent = group.path.replace(/^\//, "") || group.path;
      heading.title = group.path;
      if (group.path === path) heading.classList.add("is-current");
      const items = make("ul", "review-items");
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
    location.href = encodeHref(comment.path) + COMMENT_HASH + encodeURIComponent(id);
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

    const editor = make("div", "review-edit");
    const input = make("textarea", "review-input");
    input.rows = 3;
    input.value = comment.body;
    input.setAttribute("aria-label", "Edit comment");
    const foot = make("div", "review-composer-foot");
    const hint = make("span", "review-hint");
    hint.textContent = `${saveHint} save · Esc cancel`;
    const cancel = make("button", "review-btn");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = make("button", "review-btn review-btn-primary");
    save.type = "button";
    save.textContent = "Save";
    save.disabled = comment.body.trim() === "";
    foot.append(hint, cancel, save);
    editor.append(input, foot);

    const body = item.querySelector(".review-body");
    if (body) body.replaceWith(editor);
    else item.append(editor);

    function finish(): void {
      const next = input.value.trim();
      if (next === "") return;
      state = updateComment(state, id, next);
      writeState();
      renderAll();
    }

    input.addEventListener("input", () => {
      save.disabled = input.value.trim() === "";
    });
    save.addEventListener("click", finish);
    cancel.addEventListener("click", () => renderAll());
    input.addEventListener("keydown", (event) => {
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
    state = removeComment(state, id);
    missing.delete(id);
    writeState();
    renderAll();
  }

  // -- selection and composer ----------------------------------------------

  function hideAddButton(): void {
    addButton.hidden = true;
    if (composer.hidden) pending = null;
  }

  function positionAddButton(rect: DOMRect): void {
    const width = addButton.offsetWidth;
    const height = addButton.offsetHeight;
    let left = rect.right - width;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 6;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 6;
    if (top < 8) top = 8;
    addButton.style.left = `${left}px`;
    addButton.style.top = `${top}px`;
  }

  function positionComposer(rect: DOMRect): void {
    const width = composer.offsetWidth;
    const height = composer.offsetHeight;
    let left = rect.left;
    if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = rect.top - height - 8;
    if (top < 8) top = 8;
    composer.style.left = `${left}px`;
    composer.style.top = `${top}px`;
  }

  /** Offsets and anchor only pay for the region text when the button is used. */
  function anchorFromRange(target: Region, range: Range): Anchor | null {
    const text = target.el.textContent ?? "";
    const start = offsetOf(target.el, range.startContainer, range.startOffset);
    const end = offsetOf(target.el, range.endContainer, range.endOffset);
    if (end <= start) return null;
    const quote = text.slice(start, end);
    if (quote.trim() === "") return null;
    if (target.kind === "source") {
      const lines = lineRangeFromOffsets(text, start, end);
      return { kind: "lines", start: lines.start, end: lines.end, quote };
    }
    const anchor = makeQuoteAnchor(text, start, end);
    // The rendered selection has no Markdown syntax; map it back onto the raw
    // source so exports can carry real line numbers and a greppable excerpt.
    const source = sourceCode()?.textContent;
    if (source) {
      const hint = text.length > 0 ? Math.floor((start / text.length) * source.length) : undefined;
      const lines = mapToSourceLines(source, quote, hint);
      if (lines) {
        anchor.lines = lines;
        const span = lineOffsets(source, lines.start, lines.end);
        anchor.excerpt = source.slice(span.start, span.end);
      }
    }
    return anchor;
  }

  /** Selection changes are frequent; only the rect and a cheap containment test. */
  function updateSelection(): void {
    if (!composer.hidden) return;
    if (isEditableNode(document.activeElement)) {
      hideAddButton();
      return;
    }
    const selection = document.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      hideAddButton();
      return;
    }
    const range = selection.getRangeAt(0);
    if (isEditableNode(range.startContainer) || isEditableNode(range.endContainer)) {
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
    composer.hidden = false;
    addButton.hidden = true;
    positionComposer(pending.rect);
    composerInput.focus();
  }

  function closeComposer(): void {
    composer.hidden = true;
    composerInput.value = "";
    pending = null;
    document.getSelection()?.removeAllRanges();
  }

  function saveComment(): void {
    if (!pending) return;
    const body = composerInput.value.trim();
    if (body === "") return;
    state = addComment(
      state,
      { path: pending.path, anchor: pending.anchor, body },
      newId(),
      Date.now(),
    );
    writeState();
    closeComposer();
    renderAll();
  }

  // -- hash navigation ------------------------------------------------------

  function hashCommentId(): string | null {
    const hash = location.hash;
    if (!hash.startsWith(COMMENT_HASH)) return null;
    const raw = hash.slice(COMMENT_HASH.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  function handleHash(): void {
    const id = hashCommentId();
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

  copyBtn.addEventListener("click", () => {
    const root = rootPath();
    void copyText(toMarkdown(state, today(), root === "" ? undefined : root)).then((ok) => {
      copyBtn.textContent = ok ? "Copied" : "Copy failed";
      window.setTimeout(() => {
        copyBtn.textContent = "Copy comments";
      }, 1200);
    });
  });

  clearBtn.addEventListener("click", () => {
    if (!confirm("Clear all comments?")) return;
    state = emptyState();
    missing.clear();
    writeState();
    renderAll();
  });

  list.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (!target) return;
    const item = target.closest<HTMLElement>(".review-item");
    if (!item) return;
    const id = item.dataset.id;
    if (!id) return;
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

  addButton.addEventListener("mousedown", (event) => event.preventDefault());
  addButton.addEventListener("click", openComposer);

  composerInput.addEventListener("input", () => {
    composerSave.disabled = composerInput.value.trim() === "";
  });
  composerSave.addEventListener("click", saveComment);
  composerCancel.addEventListener("click", closeComposer);
  composerInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeComposer();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !composerSave.disabled) {
      event.preventDefault();
      saveComment();
    }
  });

  document.addEventListener("selectionchange", scheduleSelection);
  window.addEventListener("scroll", () => {
    if (composer.hidden) hideAddButton();
  }, true);
  window.addEventListener("resize", () => {
    if (composer.hidden) hideAddButton();
  });

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
      state = readState();
      renderAll();
      handleHash();
      return;
    }
    if (event.key === OPEN_KEY) setOpen(event.newValue === "1", false);
  });

  // -- start ----------------------------------------------------------------

  syncBar();
  renderAll();
  requestAnimationFrame(() => requestAnimationFrame(handleHash));
}

if (typeof document !== "undefined") initReview();
