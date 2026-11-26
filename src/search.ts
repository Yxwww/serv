import { Fzf, type FzfResultItem } from "fzf";
import { fileIcon, folderIcon } from "./icons";
import type { Entry as FileEntry, FileList } from "./files";
import { FILE_LIMIT, SHOW_HIDDEN_CLASS, SHOW_IGNORED_CLASS, rowHidden } from "./visibility";

// ---------------------------------------------------------------------------
// Pure helpers, exported so tests can prove names stay data.
// ---------------------------------------------------------------------------

export type Segment = { text: string; hit: boolean };

/**
 * Split a path into runs, marking the UTF-16 offsets fzf reported. fzf splits
 * strings with `split("")`, so its positions are code units, not code points.
 */
export function highlightSegments(path: string, positions: ReadonlySet<number>): Segment[] {
  if (positions.size === 0) return path ? [{ text: path, hit: false }] : [];
  const segments: Segment[] = [];
  let run = "";
  let runHit = false;
  for (let index = 0; index < path.length; index++) {
    const hit = positions.has(index);
    if (hit !== runHit && run) {
      segments.push({ text: run, hit: runHit });
      run = "";
    }
    runHit = hit;
    run += path[index];
  }
  if (run) segments.push({ text: run, hit: runHit });
  return segments;
}

/**
 * fzf normalizes an item before matching, so its positions index the normalized
 * string's UTF-16 units. Map them back onto whole grapheme clusters in the
 * original string, which is what a row can mark without splitting a surrogate
 * pair or drifting on a decomposed name.
 */
export function originalPositions(text: string, positions: ReadonlySet<number>): Set<number> {
  if (positions.size === 0) return new Set();
  // ASCII normalizes to itself; skip segmentation on the common path.
  if (/^[\x00-\x7f]*$/.test(text)) return new Set(positions);
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return new Set(positions);

  const mapped = new Set<number>();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let normalizedIndex = 0;
  let originalIndex = 0;
  for (const { segment } of segmenter.segment(text)) {
    const normalizedLength = segment.normalize().length;
    let hit = false;
    for (let i = 0; i < normalizedLength; i++) {
      if (positions.has(normalizedIndex + i)) hit = true;
    }
    const originalLength = segment.length;
    if (hit) for (let i = 0; i < originalLength; i++) mapped.add(originalIndex + i);
    normalizedIndex += normalizedLength;
    originalIndex += originalLength;
  }
  return mapped;
}

/** A path from the root listing to a same-origin href, one segment at a time. */
export function resultHref(path: string): string {
  const dir = path.endsWith("/");
  const bare = dir ? path.slice(0, -1) : path;
  return "/" + bare.split("/").map(encodeURIComponent).join("/") + (dir ? "/" : "");
}

export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

// ---------------------------------------------------------------------------
// One keymap for every page. Binding.key is the lowercased event.key.
// ---------------------------------------------------------------------------

export type Binding = {
  key: string;
  /** "any" matches either shift state; a symbol like "/" may require Shift on some layouts. */
  shift?: boolean | "any";
  mod?: boolean; // meta or ctrl
  allowInEditable?: boolean;
  when?: () => boolean;
  run: (event: KeyboardEvent) => void;
};

/** Shared rules in one place: modifiers, editable fields, preventDefault. */
export function dispatchKey(event: KeyboardEvent, bindings: readonly Binding[]): boolean {
  // Enter/Escape during IME composition belong to the input method.
  if (event.isComposing || event.keyCode === 229) return false;
  if (event.altKey) return false;
  const mod = event.metaKey || event.ctrlKey;
  for (const binding of bindings) {
    if (event.key.toLowerCase() !== binding.key) continue;
    if (binding.shift !== "any" && !!binding.shift !== event.shiftKey) continue;
    if (!!binding.mod !== mod) continue;
    if (!binding.allowInEditable && isEditable(event.target)) continue;
    if (binding.when && !binding.when()) continue;
    event.preventDefault();
    binding.run(event);
    return true;
  }
  return false;
}

export const RESULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Browser wiring.
// ---------------------------------------------------------------------------

const OPTION_ID = "serv-search-opt-";

export function initSearch(doc: Document): void {
  const palette = doc.getElementById("serv-palette");
  const input = doc.getElementById("serv-search-input") as HTMLInputElement | null;
  const list = doc.getElementById("serv-search-list");
  const status = doc.getElementById("serv-search-status");
  if (!palette || !input || !list || !status) return;

  let allEntries: FileEntry[] | null = null;
  let visibleEntries: FileEntry[] = [];
  let truncated = false;
  let search: Fzf<FileEntry[]> | null = null;
  let results: FzfResultItem<FileEntry>[] = [];
  let active = 0;
  let loading = false;
  let failed = false;
  let returnFocus: Element | null = null;
  let showHidden = doc.documentElement.classList.contains(SHOW_HIDDEN_CLASS);
  let showIgnored = doc.documentElement.classList.contains(SHOW_IGNORED_CLASS);

  const isPaletteOpen = (): boolean => !palette!.hidden;

  function rebuildSearch(): void {
    visibleEntries = (allEntries ?? []).filter(
      (entry) => (showHidden || !entry.hidden) && (showIgnored || !entry.ignored),
    );
    search = new Fzf(visibleEntries, { limit: RESULT_LIMIT, selector: (entry) => entry.path });
  }

  function load(): void {
    if (allEntries || loading) return;
    loading = true;
    failed = false;
    status!.textContent = "Loading files…";
    fetch("/?files")
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<FileList>;
      })
      .then((data) => {
        allEntries = Array.isArray(data.entries) ? data.entries : [];
        truncated = data.truncated === true;
        loading = false;
        failed = false;
        rebuildSearch();
        render();
      })
      .catch(() => {
        loading = false;
        failed = true;
        render();
      });
  }

  function open(): void {
    if (!palette!.hidden) return;
    returnFocus = doc.activeElement;
    palette!.hidden = false;
    doc.body.classList.add("serv-palette-open");
    input!.setAttribute("aria-expanded", "true");
    input!.value = "";
    active = 0;
    input!.focus();
    if (allEntries) render();
    else load();
  }

  function close(): void {
    if (palette!.hidden) return;
    palette!.hidden = true;
    doc.body.classList.remove("serv-palette-open");
    input!.setAttribute("aria-expanded", "false");
    input!.blur();
    const target = returnFocus as HTMLElement | null;
    if (target && typeof target.focus === "function") target.focus();
    returnFocus = null;
  }

  function move(delta: number): void {
    if (results.length === 0) return;
    active = (active + delta + results.length) % results.length;
    paintActive();
  }

  function openActive(): void {
    const hit = results[active];
    if (hit) location.href = resultHref(hit.item.path);
  }

  function paintActive(): void {
    const options = list!.querySelectorAll<HTMLElement>(".palette-option");
    for (let i = 0; i < options.length; i++) {
      const option = options[i]!;
      const on = i === active;
      option.classList.toggle("is-active", on);
      option.setAttribute("aria-selected", on ? "true" : "false");
    }
    const current = doc.getElementById(OPTION_ID + active);
    if (current) {
      input!.setAttribute("aria-activedescendant", current.id);
      current.scrollIntoView({ block: "nearest" });
    }
  }

  function render(): void {
    list!.textContent = "";
    status!.textContent = "";
    if (failed) {
      status!.textContent = "Could not load the file list.";
      input!.removeAttribute("aria-activedescendant");
      return;
    }
    if (!search) {
      status!.textContent = "Loading files…";
      return;
    }

    const query = input!.value;
    results = search.find(query);
    if (active >= results.length) active = results.length - 1;
    if (active < 0) active = 0;

    if (results.length === 0) {
      const empty = doc.createElement("li");
      empty.className = "palette-empty";
      empty.textContent = query
        ? "No matches"
        : (allEntries?.length ?? 0) === 0
          ? "No files under this folder"
          : "All files are hidden";
      list!.append(empty);
      input!.removeAttribute("aria-activedescendant");
      status!.textContent = statusText(query);
      return;
    }

    const fragment = doc.createDocumentFragment();
    results.forEach((result, index) => {
      const entry = result.item;
      const path = entry.path;
      const dir = path.endsWith("/");
      const li = doc.createElement("li");
      li.className = "palette-option";
      li.id = OPTION_ID + index;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", index === active ? "true" : "false");
      if (index === active) li.classList.add("is-active");

      const icon = doc.createElement("span");
      icon.className = "palette-icon";
      // Constant SVG from icons.ts, never a filename.
      icon.innerHTML = dir ? folderIcon() : fileIcon(basename(path));

      const label = doc.createElement("span");
      label.className = "palette-path";
      label.title = path;
      for (const segment of highlightSegments(path, originalPositions(path, result.positions))) {
        if (!segment.hit) {
          label.append(segment.text);
          continue;
        }
        const mark = doc.createElement("mark");
        mark.className = "palette-hit";
        mark.textContent = segment.text;
        label.append(mark);
      }

      li.append(icon, label);
      li.addEventListener("mousemove", () => {
        if (active === index) return;
        active = index;
        paintActive();
      });
      li.addEventListener("click", () => {
        location.href = resultHref(path);
      });
      fragment.append(li);
    });

    list!.append(fragment);
    paintActive();
    status!.textContent = statusText(query);
  }

  function statusText(query: string): string {
    const total = visibleEntries.length;
    const parts: string[] = [];
    if (query) {
      const more = total > RESULT_LIMIT ? "+" : "";
      const label = results.length === 1 ? "result" : "results";
      parts.push(`${results.length}${more} ${label}`, `${total.toLocaleString()} paths`);
    } else {
      parts.push(`${total.toLocaleString()} paths`);
      if (total > RESULT_LIMIT) parts.push(`showing first ${RESULT_LIMIT}`);
    }
    if (truncated) parts.push(`showing first ${FILE_LIMIT / 1000}k`);
    return parts.join(" · ");
  }

  function updateIndicator(): void {
    const button = doc.querySelector<HTMLButtonElement>("[data-serv-hidden-count]");
    if (!button) return;
    let count = 0;
    for (const row of doc.querySelectorAll<HTMLElement>(".listing tbody tr")) {
      if (rowHidden(row.hasAttribute("data-hidden"), row.hasAttribute("data-ignored"), showHidden, showIgnored)) {
        count++; // one entry per row, even if both tags apply
      }
    }
    button.hidden = count === 0;
    button.textContent = `${count} hidden`;
    const label = count === 1 ? "entry" : "entries";
    button.setAttribute("aria-label", count === 0 ? "Show hidden entries" : `Show ${count} hidden ${label}`);
  }

  function setShown(kind: "hidden" | "ignored", on: boolean): void {
    const cls = kind === "hidden" ? SHOW_HIDDEN_CLASS : SHOW_IGNORED_CLASS;
    doc.documentElement.classList.toggle(cls, on);
    try {
      localStorage.setItem(cls, on ? "1" : "0");
    } catch {
      // Private mode or storage disabled: the class still applies this page.
    }
    if (kind === "hidden") showHidden = on;
    else showIgnored = on;
    updateIndicator();
    if (allEntries) rebuildSearch();
    if (isPaletteOpen()) render();
  }

  function toggle(kind: "hidden" | "ignored"): void {
    setShown(kind, kind === "hidden" ? !showHidden : !showIgnored);
  }

  input.addEventListener("input", () => {
    active = 0;
    render();
  });

  palette.addEventListener("click", (event) => {
    const target = event.target as Element | null;
    if (target && target.hasAttribute("data-palette-close")) {
      close();
      return;
    }
    input.focus(); // a click on the panel must not leave the arrow keys dead
  });

  // One quiet control: click shows everything and saves that choice.
  doc.querySelector("[data-serv-hidden-count]")?.addEventListener("click", () => {
    setShown("hidden", true);
    setShown("ignored", true);
  });
  updateIndicator();

  const hasViewer = (): boolean => doc.getElementById("serv-viewer-img") !== null;
  const navOpen = (): boolean => doc.body.classList.contains("nav-open");
  const step = (direction: "prev" | "next"): void => {
    doc.querySelector<HTMLElement>(`.image-step[rel="${direction}"]`)?.click();
  };

  const bindings: Binding[] = [
    { key: "escape", allowInEditable: true, when: isPaletteOpen, run: close },
    { key: "escape", when: navOpen, run: () => (doc.querySelector(".nav-close") as HTMLElement | null)?.click() },
    { key: "/", shift: "any", when: () => !isPaletteOpen(), run: open },
    { key: "k", mod: true, allowInEditable: true, when: () => !isPaletteOpen(), run: open },
    { key: "h", shift: true, when: () => !isPaletteOpen(), run: () => toggle("hidden") },
    { key: "i", shift: true, when: () => !isPaletteOpen(), run: () => toggle("ignored") },
    { key: "arrowdown", allowInEditable: true, when: isPaletteOpen, run: () => move(1) },
    { key: "n", mod: true, allowInEditable: true, when: isPaletteOpen, run: () => move(1) },
    { key: "arrowup", allowInEditable: true, when: isPaletteOpen, run: () => move(-1) },
    { key: "p", mod: true, allowInEditable: true, when: isPaletteOpen, run: () => move(-1) },
    { key: "enter", allowInEditable: true, when: isPaletteOpen, run: openActive },
    { key: "tab", allowInEditable: true, when: isPaletteOpen, run: () => {} },
    { key: "tab", shift: true, allowInEditable: true, when: isPaletteOpen, run: () => {} },
    { key: "arrowleft", when: hasViewer, run: () => step("prev") },
    { key: "arrowright", when: hasViewer, run: () => step("next") },
  ];

  doc.addEventListener("keydown", (event) => dispatchKey(event, bindings), true);

  // Module scripts run after parsing, so the palette markup is already present.
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

if (typeof document !== "undefined") initSearch(document);
