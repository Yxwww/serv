import { CODE_EXTS, HTML_EXTS, IMAGE_EXTS, JSON_EXTS, TEXT_EXTS, isMarkdown } from "./types";

/**
 * Inline SVG icons. Paths are from Lucide (ISC); inlined so a page makes no
 * network requests. Every icon inherits `currentColor` and sizes from `font-size`.
 */
const ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="icon"';

export function folderIcon(): string {
  return `<svg ${ATTRS}><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`;
}

export function folderOpenIcon(): string {
  return `<svg ${ATTRS}><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>`;
}

export function fileIcon(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  if (IMAGE_EXTS.has(ext)) return fileImage();
  if (JSON_EXTS.has(ext)) return fileJson();
  if (CODE_EXTS.has(ext) || HTML_EXTS.has(ext)) return fileCode();
  if (TEXT_EXTS.has(ext) || isMarkdown(ext)) return fileText();
  return filePlain();
}

export function menuIcon(): string {
  return `<svg ${ATTRS}><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg>`;
}

export function closeIcon(): string {
  return `<svg ${ATTRS}><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
}

const DOC = `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`;

function filePlain(): string {
  return `<svg ${ATTRS}>${DOC}</svg>`;
}

function fileText(): string {
  return `<svg ${ATTRS}>${DOC}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>`;
}

function fileCode(): string {
  return `<svg ${ATTRS}>${DOC}<path d="m10 13-2 2 2 2"/><path d="m14 17 2-2-2-2"/></svg>`;
}

function fileJson(): string {
  return `<svg ${ATTRS}>${DOC}<path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/></svg>`;
}

function fileImage(): string {
  return `<svg ${ATTRS}>${DOC}<circle cx="10" cy="12" r="1.5"/><path d="m20 17-2.5-2.5a2 2 0 0 0-2.8 0L8 21"/></svg>`;
}
