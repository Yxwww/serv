import { SPRITE_URL, iconIdFor, type IconId } from "./file-icons";

/**
 * Icons come from one cached sprite; a row only pays for a small `<use>`.
 * Strokes and fills inherit `currentColor`, so dark mode needs no rules.
 */
function iconMarkup(id: IconId): string {
  return `<svg class="icon" aria-hidden="true"><use href="${SPRITE_URL}#fi-${id}"></use></svg>`;
}

export function fileIcon(name: string): string {
  return iconMarkup(iconIdFor(name, false));
}

export function folderIcon(): string {
  return iconMarkup("folder");
}

export function folderOpenIcon(): string {
  return iconMarkup("folder-open");
}

export function menuIcon(): string {
  return iconMarkup("menu");
}

export function closeIcon(): string {
  return iconMarkup("x");
}

/** Palette rows: a path ends in `/` exactly for a directory. */
export function paletteIcon(path: string): string {
  const dir = path.endsWith("/");
  const name = dir ? "" : path.slice(path.lastIndexOf("/") + 1);
  return iconMarkup(iconIdFor(name, dir));
}
