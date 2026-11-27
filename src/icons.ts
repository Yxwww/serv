import { EXTENSION_ICONS, SPECIAL_NAMES, SPRITE_URL, iconIdFor, type IconId } from "./file-icons";

/**
 * Icons come from one cached sprite; a row only pays for a small `<use>`.
 * Strokes and fills inherit `currentColor`, so dark mode needs no rules.
 */
function iconMarkup(id: IconId): string {
  return `<svg class="icon" aria-hidden="true"><use href="${SPRITE_URL}#fi-${id}"></use></svg>`;
}

// Every id `iconIdFor` can return, plus the UI-only glyphs. Building this once
// makes each rendered row a map lookup instead of a template allocation.
const UI_IDS: IconId[] = ["file", "file-settings", "folder", "folder-open", "menu", "message", "x"];

function buildMarkup(): Map<IconId, string> {
  const markup = new Map<IconId, string>();
  for (const id of [...EXTENSION_ICONS.values(), ...SPECIAL_NAMES.values(), ...UI_IDS]) {
    markup.set(id, iconMarkup(id));
  }
  return markup;
}

// Pure so the table (and the id list) tree-shakes out of the browser bundle,
// where only `paletteIcon` is used.
const MARKUP = /* @__PURE__ */ buildMarkup();
const FILE_MARKUP = /* @__PURE__ */ iconMarkup("file");

/** A missing id must never render the text "undefined". */
function markupFor(id: IconId): string {
  return MARKUP.get(id) ?? FILE_MARKUP;
}

/** Test hook: every id `iconIdFor` can return must be cached. */
export function hasIconMarkup(id: IconId): boolean {
  return MARKUP.has(id);
}

export function fileIcon(name: string): string {
  return markupFor(iconIdFor(name, false));
}

export function folderIcon(): string {
  return markupFor("folder");
}

export function folderOpenIcon(): string {
  return markupFor("folder-open");
}

export function menuIcon(): string {
  return markupFor("menu");
}

export function messageIcon(): string {
  return markupFor("message");
}

export function closeIcon(): string {
  return markupFor("x");
}

/** Palette rows: a path ends in `/` exactly for a directory. */
export function paletteIcon(path: string): string {
  const dir = path.endsWith("/");
  const name = dir ? "" : path.slice(path.lastIndexOf("/") + 1);
  return iconMarkup(iconIdFor(name, dir));
}
