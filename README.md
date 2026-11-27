# serv

[![CI](https://github.com/Yxwww/serv/actions/workflows/ci.yml/badge.svg)](https://github.com/Yxwww/serv/actions/workflows/ci.yml)

A tiny local web server that renders Markdown and serves everything else as-is.

No runtime dependencies, no config, and no build step to use it. Point it at a
folder and read it in the browser, with a file tree down the left side.

## Requirements

Bun **1.3.8 or newer**. `serv` uses the built-in `Bun.markdown` renderer, which
first shipped in [Bun v1.3.8](https://bun.com/blog/bun-v1.3.8).

## Install

From GitHub:

```bash
bun install -g github:Yxwww/serv
```

From a clone:

```bash
git clone https://github.com/Yxwww/serv.git
cd serv
bun link
```

Uninstall:

```bash
bun remove -g serv   # installed with bun install -g
bun unlink           # installed with bun link; run inside the cloned repo
```

## Usage

```bash
serv                          # serve the current directory
serv path/to/folder           # serve a folder
serv path/to/report.md        # serve one file; its parent becomes the root
serv --port 5000 --no-open    # custom port, don't open a browser
serv --help                   # show usage (`-h` is the short form)
```

It binds `127.0.0.1` only, prints the URL, and opens the browser unless
`--no-open` is passed. The default port is derived from the served folder
(4400-4899), so the same folder gets the same URL on every run; if the port is
taken it walks forward to the next free one. Pass `--port N` to pick the first
port yourself.

On macOS with a Chromium browser running, serv reuses an existing tab for the
same URL instead of opening a new one.

`--base DIR` resolves a relative path against another directory, which is handy
when a wrapper launches the CLI from somewhere else.

### What each URL does

| URL | Response |
|---|---|
| `/note.md` | rendered Markdown page |
| `/note.md?raw` | the Markdown source as `text/plain` |
| `/folder/` | listing, grid by default; directories first, then files |
| `/folder/?view=list`, `/folder/?view=grid` | the chosen view |
| `/folder/?showall=1` | all entries instead of the first 300 |
| `/folder/?tree` | the sidebar's children for that folder, as an HTML fragment |
| `/folder/?files` | every file under that folder and its containing folders, tagged hidden/ignored, as JSON for the search palette |
| `/folder/` with `index.html` | that file instead of the listing |
| `/folder/` with `README.md` | the rendered README beside the files |
| `/image.png`, `/doc.pdf`, `/clip.mp4` | a viewer page when opened as a top-level navigation; the raw file for page subresources |
| `/script.ts`, `/config.toml`, `/notes.txt` | a source page with line numbers |
| `/script.ts?raw`, `/notes.txt?raw` | the file as `text/plain` |
| `/data.json`, `/bundle.map` | pretty-printed JSON with line numbers when opened as a navigation; raw for subresources |
| anything missing | a 404 page showing the path, a link home, and the parent listing |

A file argument switches to single-file mode: its parent becomes the root, so
relative links and images in the file resolve normally. Dotfiles and
gitignored paths are listed too; both are hidden by default and can be shown
with the keys described below.

## Hidden and ignored entries

Every listing, sidebar and search result knows whether a path is a dotfile or
is ignored by an ignore file inside the served folder. Both are hidden by
default. `Shift+H` shows or hides dotfiles and `Shift+I` shows or hides ignored
entries; the choice is saved in `localStorage` under `serv-show-hidden` and
`serv-show-ignored`.

A folder listing shows one quiet line in its files header, such as `3 hidden`,
counting the rows currently hidden and counting a row that is both a dotfile
and ignored once. Hovering names the keys. Clicking the line shows everything
and saves that choice; use `Shift+H`/`Shift+I` to hide again. When nothing is
hidden the line is absent. The line needs JavaScript. Without JavaScript,
dotfiles stay hidden and ignored entries are shown.

The server tags rows in HTML (`data-hidden`, `data-ignored`) and flags them in
`?files`; visibility is decided in the browser. A small head script applies the
saved choice to `<html>` before the first paint, so nothing flashes. `.git` is
always excluded.

Listings and the sidebar tag the rows of the folder being rendered with one
`git check-ignore` call over those paths, so a 50k scan cap cannot drop a tag.
Only rules whose source file is inside the served root count: parent
`.gitignore` files and global excludes do not, and a negated (`!`) match means
not ignored. Outside a git repository, or without git, there is no ignored
tagging, the same as without ripgrep; dotfiles still count. The `?files` list
uses the cached `rg` scan instead (below) and can tag a non-repo tree's
`.gitignore`; that palette cap is independent of the listing tags.

## Sidebar

Every rendered page carries a file tree on the left, 260px wide and pinned to
the edge with its own scroll. The folders leading to the current page start
expanded and the current entry is highlighted; everything else starts collapsed
and loads its children on first open from `GET /folder/?tree`. Each folder is
read one level at a time, capped at 300 entries with a "… N more" link to the
folder's listing, which has its own "Show all" link, so even a checkout with
`node_modules` stays quick. Dotfiles and ignored entries are rows too, tagged
and hidden by default; the 300-row cap counts them. Rows indent
12px per level (capped at six) with a guide line for each ancestor. Without
JavaScript the folder names are ordinary links to their listings. Below 800px
the sidebar becomes a drawer behind a menu button in the header, with a
backdrop and a close button; with JavaScript off it stays an in-flow tree
above the content instead.

## File search

Press `/` on any page (or Cmd/Ctrl+K) to open a command palette over the whole
served tree. It ranks paths with [fzf's algorithm](https://github.com/ajitid/fzf-for-js)
in the browser, so each keystroke is instant and no request leaves the machine
after the first list load. Matched characters are highlighted, folders appear
with a trailing slash, ↑/↓ or Ctrl+N/P move, Enter opens, and Esc or a click
outside closes and returns focus to the page. The list comes from
`GET /folder/?files`, which uses `rg --files` when ripgrep is installed (so
the served tree's own `.gitignore` applies, while ignore rules from parent
directories and the machine's global ignore file do not) and otherwise walks
the tree skipping `.git` and symlinks. It returns paths in path order, tagged
hidden or ignored, stops at 50,000 entries, fills the cap with non-ignored
paths first, and says when it truncated. The palette applies the same
`Shift+H`/`Shift+I` choices as the listing; because both start hidden, it
initially ranks only the visible paths.

## Listing views

Folders open in a grid of cards: image thumbnails over a checkerboard, large
folder and file-type icons, and the name, size and modified time below. The
List / Grid toggle is two links (`?view=list` and `?view=grid`), so it works
without JavaScript. With no `view` parameter, a small inline script applies the
last choice stored in localStorage, falling back to grid. Both views are in the
page, so applying the stored choice needs no redirect or second request. Both
views stop at 300 rows with a "Show all" link. `?showall=1`, `?showall=true`,
or a bare `?showall` lifts the cap; `0`, `false`, and an empty value do not.
The cap counts tagged rows too: the server cannot see a browser's hide/show
choices, so a page may show fewer than 300 visible rows until "Show all" is
used.

A folder with a `README.md` stacks the README and files by default. Once the
content area reaches 58rem it becomes a 2:1 row, and the files panel turns
sticky with its own scroll. One container query controls both, so the split and
the sticky panel always agree. Stacked layouts stay in normal page flow, so
there is no nested scroll trap. The files list keeps only name and size when
that panel is narrow.

## Source view

Text and source files get the same page chrome: breadcrumbs, the sidebar, and
the file inside a `<pre>` with line numbers. Above 1 MB only the first 1 MB is
shown, with a link to `?raw` for the whole file. Markdown pages and a folder's
README are capped the same way. Add `?raw` to any of them for the untouched
`text/plain` file.

## File viewers

Opening an image, PDF, video, audio file, HTML page, JSON file or other binary
as a top-level navigation keeps the shell: the sidebar, breadcrumbs and a
viewer.

| File | Viewer |
|---|---|
| PNG, JPEG, GIF, WebP, SVG, AVIF, ICO, BMP | centred image on a transparency checkerboard, with dimensions and file size; click for raw; Previous/Next or ←/→ steps through the folder's images |
| `.json`, `.map`, `.geojson`, `.webmanifest` | pretty-printed with line numbers; invalid JSON falls back to the raw text |
| PDF | embedded in an iframe |
| video, audio | native browser player; byte-range responses let it seek |
| HTML | embedded in an iframe at its own URL, so relative assets still resolve |
| anything else | a card with the name, type, size and a download link |

Every page has a `raw` link for the untouched file. Viewers label it `raw ↗`
because it opens in a new tab. The viewer distinction is made with the
`Sec-Fetch-Dest` request header: only `document` navigations get a viewer.
Subresource requests (`img`, `iframe`, `style`, `script`, `fetch`) get exactly
the raw bytes with the file's own content type (`text/css`, `text/javascript`,
`text/markdown`, and so on). With no header, Markdown and text files still open
in the shell and binary files are raw. Safari and WebKit do not always send
`Sec-Fetch-Dest`, so their image, PDF, video and HTML navigations may fall back
to the raw file. Responses whose body depends on that header send
`Vary: Sec-Fetch-Dest`, and `?raw` always forces the raw bytes.

## Markdown

GitHub-flavoured Markdown: tables, fenced code blocks, task lists, and
autolinks. Heading ids follow GitHub's slugger, so anchors such as
`#severity-notes` and `#b1--blocker-early-arrival` work, including across files.

One edge case: enclosed alphanumerics and combining marks can produce a
different id than GitHub does.

## Security

- Binds `127.0.0.1` only, so it is not reachable from other machines.
- Path traversal is rejected: paths are decoded, `..` segments are refused, and
  the result must stay inside the served root.
- Symlinks are followed even when they point outside the root. This is
  deliberate, for linked asset or evidence directories. Don't serve a tree you
  don't trust.
- Served HTML and raw HTML inside Markdown run same-origin with the rest of the
  tree. There is no Content-Security-Policy, so a page can fetch sibling files.
  Raw HTML is not sanitized. Serve trusted trees only.

## Development

```bash
bun install          # build tooling only; nothing is required at runtime
bun run build:css    # regenerate src/styles.css from src/styles.input.css
bun run build:search # regenerate src/search.bundle.js from src/search.ts
bun test             # tests live next to the code in src/
bunx tsc --noEmit    # typecheck
bun run start        # run the CLI from the checkout
```

CI runs `bun test` and the typecheck on Bun 1.3.8. The stylesheet test rebuilds
`src/styles.css` and fails if it differs, so a forgotten `build:css` cannot land.
The same is true of `src/search.bundle.js`, which is the browser bundle of
`src/search.ts` (with its fzf ranking) inlined into every page; a forgotten
`build:search` fails the bundle test.

Claude Code contributors: `.claude/skills/dev/SKILL.md` covers the repo map, invariants, dev loop, and review workflow.

`src/styles.css` is generated by Tailwind CSS v4 and committed, so installing
from GitHub needs no build step. Edit `src/styles.input.css` (theme tokens and
component styles) and run `build:css`; a test fails if the committed CSS is
stale. Tailwind scans only `src/*.ts`, so keep utility class names in those
files.

`src/render.ts` builds pages, listings and viewers, `src/tree.ts` builds the
sidebar and its lazy fragments, `src/serve.ts` does routing and content types,
`src/types.ts` holds the extension table shared by routing and icons,
`src/icons.ts` holds the shared UI icons, and `src/cli.ts` handles flags, the
port, and opening the browser.

File-type icons come from a 49-glyph subset of [Tabler Icons](https://tabler.io/icons)
(MIT). `scripts/build-file-icons.ts` (`bun run build:icons`) maps extensions
and special filenames to sprite ids and generates `src/file-icons.ts` and
`src/file-icon-sprite.ts`; the sprite is served once per browser cache at
`/?icons=<hash>` with immutable caching, and rows reference it with `<use>`.

## Credits

Design tokens are from [Astryx](https://github.com/meta/astryx) by Meta
Platforms, Inc. (MIT). File-type icons are a subset of [Tabler Icons](https://tabler.io/icons)
(MIT). File ranking is from [fzf for JavaScript](https://github.com/ajitid/fzf-for-js) by
Ajit (BSD-3-Clause). See `THIRD_PARTY_NOTICES.md`.

## License

MIT © 2026 Yuxi Wang
