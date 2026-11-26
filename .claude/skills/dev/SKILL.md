---
name: dev
description: "Use when changing serv: features, fixes, styling, refactors, or reviews."
---

# Developing serv

A small Bun server: render Markdown, show folders as pages, serve everything
else as bytes. Keep it plain and dependency-free.

## Repo map

- `src/cli.ts` — argument parsing, port walk, browser open; hands requests to `respond`.
- `src/serve.ts` — routing, containment, `Sec-Fetch-Dest` gate, raw file responses, Range/HEAD, content types.
- `src/render.ts` — page shell, listing/grid/list, README split, Markdown/source/viewers, escaping, inline scripts.
- `src/tree.ts` — sidebar tree and lazy `?tree` fragments.
- `src/files.ts` — the cached `?files` scan (two `rg --files` passes, or a capped walk without rg) plus `tagRows`, the per-folder `git check-ignore` tagger used by listings, the sidebar and `?tree`.
- `src/search.ts` → `src/search.bundle.js` — browser command palette (fzf ranking), the hidden-entry indicator, and the one page-wide keymap; bundled and committed, tested for staleness.
- `src/icons.ts` — inline Lucide SVGs; no icon requests.
- `src/types.ts` — the single extension/name table shared by routing, viewers, and icons.
- `src/styles.input.css` → `src/styles.css` — Tailwind input; generated CSS is committed and tested for staleness.
- `src/serve.test.ts` — routing, rendering, CSS, security, and media tests.
- `.github/workflows/ci.yml` — Bun 1.3.8, `bun test`, `bunx tsc --noEmit`.

## Invariants

Every change must leave these true. The named tests are the guard.

- **Raw gate.** A non-`document` `Sec-Fetch-Dest` returns raw bytes with the file's own MIME; `?raw` also forces raw bytes (text is `text/plain`). No header means text/Markdown in the shell and binary raw. Guards: “?raw returns the source instead of a page”, “Sec-Fetch-Dest: document gets viewers; image/iframe/none get raw bytes; ?raw overrides”, “non-document destinations get the file's own type…”.
- **Vary.** Responses whose body depends on `Sec-Fetch-Dest` send `Vary: Sec-Fetch-Dest`. Guards: the two destination tests above.
- **Escaping.** Escape every name and path in HTML; encode every URL segment with the shared helpers. Guards: “directories first, then files by name, dotfiles tagged, names escaped”, “grid cards escape names and encode image links”, “special characters are escaped in the tree, listing, breadcrumbs, title and 404”, “image viewer hrefs and labels escape awkward filenames”.
- **Containment.** Decode first, reject `..`, then require a lexical prefix of the root. Root `/` is valid. Symlinks are followed on purpose; do not “fix” that. Guards: “traversal is rejected, including encoded ..”, “a raw request cannot reach a real file outside the root”, “a root of / still resolves children”, “a missing directory's parent link drops its trailing slash”.
- **Caps.** 300 rows in the tree and in each listing view (`ENTRY_LIMIT`), counting tagged rows because the server cannot see a browser's hide/show choice; 1 MB for source and Markdown, cut on a UTF-8 boundary; 50,000 paths for `?files` (`FILE_LIMIT`), filled with non-ignored paths first and stopped by killing `rg` once the next entry appears; display order is path order on both the `rg` and walk backends. Page and sidebar tags never depend on that scan cap. Guards: “caps each folder and links the rest to the full listing”, “both views cap at 300 and Show all lifts both”, “large files are capped at 1 MB…”, “the byte cap does not split a UTF-8 character”, “combineFiles lists in path order and fills the cap with real paths first”, “the reader stops at the cap and tells the producer to stop”.
- **Tagging, not dropping.** Every listing, tree and `?files` row carries `data-hidden` / `data-ignored` (or the JSON flags) for dotfiles and for paths matched by ignore files *inside* the served root. Listings and the sidebar run one `git check-ignore -v -z` per page over exactly the rows they render (`tagRows`), so the `?files` cap cannot lose a tag; only sources inside the served root count, and a `!` match is not ignored. Outside a git repo or without git there is no ignored tagging; `?files` keeps its `rg` scan and its own non-repo behaviour. `.git` is always excluded. Browse and tree follow symlinks; `?files` and its fallback do not. `check-ignore` fails a whole batch on a path behind a symlink or inside a submodule, so `tagRows` skips those rows; a hard failure is halved down to rows, and a 2s timeout returns no ignored tags. Guards: “?files lists tagged paths…”, “?files without ripgrep keeps the path order…”, “?files keeps a parent-ignored folder…”, “the no-ripgrep walk includes dotfiles…”, “tags a folder from its own rules even when the scan cap is forced”, “ignores parent rules but keeps the served tree's own rules”, “leaves ignored tags off outside a git repo”, “the indicator counts each hidden entry once”.
- **Visibility is client state.** Both kinds are hidden by default. The pre-paint head script adds `serv-js` and applies `serv-show-hidden` / `serv-show-ignored` on `<html>` from localStorage before the first paint. CSS hides `[data-hidden]` always, but hides `[data-ignored]` and shows the `N hidden` button only under `html.serv-js`. So without JS dotfiles stay hidden and ignored entries are shown; document that in any new visibility surface. Do not hide either kind on the server. A folder's files header carries one quiet `N hidden` button (unique rows; detailed `aria-label`; key tooltip); clicking it shows everything and saves that choice. Guards: “pages carry the hidden palette dialog and the pre-paint state”, “a listing inside a dot-directory reports its hidden rows”, plus the browser no-flash and indicator checks.
- **One keymap.** Every page-level shortcut is a `Binding` in the single table passed to `dispatchKey`. Shared rules (editable fields, modifiers, IME composition, `preventDefault`) live only in the dispatcher. Guard: “applies modifiers, editable fields, guards and preventDefault once”, “leaves IME composition keys to the input method”.
- **No runtime deps or external requests.** `package.json` has no `dependencies`; CSS, icons, fzf and the favicon are inline; Tailwind and fzf are build-time only. Guards: `package.json`, “every page carries an inline SVG favicon”, and the browser network log.
- **Tokens in one place.** Astryx `--a-*` values live in the `:root`/dark block of `styles.input.css`; `@theme inline` maps them to utilities. Components use tokens, not copied colors or radii. Guard: “src/styles.css is the current build of src/styles.input.css” plus review; keep new literals out of `render.ts`.
- **Depth is server data.** Every tree row gets `--depth` from the server; do not infer indentation from DOM nesting or `details`. Guards: “rows carry the parent directory's depth, including ?tree fragments”, “the more row carries the depth of the level it ends”.
- **One layout condition.** Side-by-side and sticky share the single `@container listing (min-width: 58rem)`; default is stacked and static. At 1280px the content is ~57.75rem, so it stacks. Guard: browser width matrix (no unit test).
- **Internal ids.** Prefix new ids with `serv-` (`serv-tree`, `serv-viewer-img`, …). Guards: “expands only the ancestors of the current page and marks the active entry”, “the narrow drawer has a no-script layout”, and review.
- **Ranges and HEAD.** Raw responses accept one byte range, send `Accept-Ranges: bytes`, return 416 for unsatisfiable ranges, and let malformed/multi-range fall through to 200. HEAD carries GET’s headers with no body. Guards: “raw files honour one byte range, suffix and open-ended forms”, “HEAD returns response headers without a body”.

## Dev loop

```bash
bun install
bun run build:css        # after any class or CSS change
bun run build:search     # after any change to src/search.ts
bun test
bunx bun@1.3.8 test      # CI's version
bunx tsc --noEmit
bun run src/cli.ts --no-open --port 4495 <dir>
```

`build:css` is mandatory after class changes: “src/styles.css is the current
build…” fails otherwise. Tailwind scans only `src/*.ts`; keep utility class
names in those files, not only in CSS strings. `build:search` is the same for
`src/search.ts` → `src/search.bundle.js`; the bundle must stay byte-identical
under Bun 1.3.8 and newer, which is why it uses `--format=esm`.

## Test against real data

Use a copy of a report tree shaped like `reports/<feature>/<feature>.md` plus
`reports/<feature>/*.png`, with a root README and some nested folders. Fifteen
to thirty features exercises the README split, grid/list, image stepping, and
long names. For scale, generate a temporary 10k-file folder; check the page
stays near the 300-entry size. Do not edit the source fixture.

## Workflow by risk

- Agree the design first, with one round of screenshots before building. Most
  rework in this repo came from building before the layout was settled.
- Reproduce first, in the same step as the fix. A visual bug needs the browser;
  a server bug needs a failing `respond()` assertion or `curl`.
- New logic or security-sensitive code (routing, escaping, containment, the
  destination gate, Range) gets an independent code review plus browser QA.
- Small fixes get tests plus a `curl` check inline; do not spin up a review
  ceremony for a one-line correction.
- Batch reviewer findings into one implementer round. Re-review the batch once,
  not every bullet separately.
- Write the QA checklist before implementation. A good default:
  widths 600/1000/1280/1440/1920; light and dark; keyboard-only and no-JS;
  every viewer type; media seeking; a 10k-entry folder; a network log showing
  only 127.0.0.1; hostile filenames; a git fixture with dotfiles, `.gitignore`
  and `node_modules` for hidden defaults, the `N hidden` click, the keys and
  the no-flash check; and a Range `curl`.
- Use one named `agent-browser` session for the task and close it at the end.
  Measure with computed styles, bounding rects, `naturalWidth`, and events.
  Do not judge layout or icon size by eyeballing a screenshot.

## Shipping

- Branch `feat/…` or `fix/…`; keep the worktree clean before handoff.
- Commit with a why body. The local hook rejects a subject-only commit.
- Open a Draft PR with Why / What / Verification; link the issue when there is one.
- CI must pass on Bun 1.3.8.
- After merge, update the global install: `bun install -g github:Yxwww/serv`.
  Smoke-test it from outside the checkout (for example `/tmp`) so a file that
  only exists in your working tree is caught.

## Non-goals and gotchas

- No writes, uploads, delete, auth, or live reload. serv is a read-only viewer
  bound to loopback.
- No CSP or sandbox. Raw HTML and Markdown links are trusted; serve trusted
  trees only.
- No recursive tree render: read one directory per request and load children on
  demand. The root scan in `files.ts` is recursive but cached; use its tags
  instead of walking again for hidden/ignored state.
- Safari may omit `Sec-Fetch-Dest`; its media/PDF/image navigations can fall
  back to raw bytes. That is why `?raw` exists and why the viewer gate is
  conditional, not a redirect.
- Tailwind 4.3.5 silently emitted nothing for `@theme reference inline`; use
  `@theme inline`.
- Bun maps `.ts` to a non-text MIME; `types.ts` exists so routing does not
  trust Bun’s extension guess.
- Tree folders are `<li><details><summary>`; DOM selectors must account for
  the `details` node. Do not assume an anchor is the first child.
- The list and grid share the 300 cap. `?showall` is on only for `1`, `true`,
  or a bare parameter; `0`, `false`, and `?showall=` stay capped.
- `Bun.file(path).slice(a, b + 1)` is lazy; never read a whole media file to
  answer a range. Range applies only to raw responses; shell and viewer HTML
  stay full 200s with `Vary`.
- The 300 caps are `ENTRY_LIMIT` and `MAX_TREE_ENTRIES`; do not hard-code
  another 300.
- Tailwind scans tests too. A class-like string added to a test can change
  `styles.css`; rebuild and review the diff before handoff.
- The listing view persists in `localStorage` under `serv-view`; the two
  visibility choices persist under `serv-show-hidden` and `serv-show-ignored`
  (`"1"`/`"0"`). Both default hidden. Clear or set them before a screenshot,
  or the page may show the other view or show rows.
- The scan cache is 30 seconds per root and only `?files` uses it. A test or
  dev loop that creates files and requests `?files` twice within the TTL sees
  the first scan; use a fresh fixture directory.
- `tagRows` runs `git check-ignore` from the served root and resolves sources
  against `git rev-parse --show-toplevel`; the root is realpathed because macOS
  temp dirs are symlinks under `/var`. A path behind a symlink or inside a
  submodule makes `check-ignore` fail the whole batch, so those rows are
  skipped; other hard failures halve the batch to isolate the bad rows, and a
  2s timeout reaps git and returns no ignored tags.
- A non-repo tree has no listing/tree ignored tags, but `?files` still uses
  `rg --no-require-git` and can tag its `.gitignore`. Do not “fix” the
  divergence without changing the `?files` scan too.
- The dev server does not hot-reload. Restart it after a source change, or the
  screenshot and Range check will exercise the old build.
