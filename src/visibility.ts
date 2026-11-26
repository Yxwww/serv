/**
 * Shared by the server page and the browser bundle, so it must not import
 * `node:*` or anything that does.
 */

/** The browser bundle prints the cap too, and cannot import files.ts (node:fs). */
export const FILE_LIMIT = 50_000;

/** Both kinds are hidden by default; the pre-paint script restores the choice. */
export const SHOW_HIDDEN_CLASS = "serv-show-hidden";
export const SHOW_IGNORED_CLASS = "serv-show-ignored";

/** A row counts once even when both tags apply. */
export function rowHidden(
  hidden: boolean,
  ignored: boolean,
  showHidden: boolean,
  showIgnored: boolean,
): boolean {
  return (hidden && !showHidden) || (ignored && !showIgnored);
}
