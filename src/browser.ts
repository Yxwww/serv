// Tiny DOM helpers shared by the browser bundles. No runtime dependencies.

/** A path from the served root to a same-origin href, one segment at a time. */
export function resultHref(path: string): string {
  const dir = path.endsWith("/");
  const bare = dir ? path.slice(0, -1) : path;
  return "/" + bare.split("/").map(encodeURIComponent).join("/") + (dir ? "/" : "");
}

/** True for inputs, textareas, selects and contenteditable elements (or their text nodes). */
export function isEditable(target: EventTarget | Node | null): boolean {
  if (!target) return false;
  const node = target as Node;
  const el =
    typeof node.nodeType === "number" && node.nodeType !== 1
      ? (node.parentElement as HTMLElement | null)
      : (target as HTMLElement);
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}
