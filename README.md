# serv

A tiny local web server that renders Markdown and serves everything else as-is.

No dependencies, no config, no build step. Point it at a folder and read it in
the browser.

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
`--no-open` is passed. The default port is 4400; if it is taken it walks
forward to the next free one.

`--base DIR` resolves a relative path against another directory, which is handy
when a wrapper launches the CLI from somewhere else.

### What each URL does

| URL | Response |
|---|---|
| `/note.md` | rendered Markdown page |
| `/note.md?raw` | the Markdown source as `text/plain` |
| `/folder/` | index listing: breadcrumb, directories first, then files with size and modified time |
| `/folder/` with `index.html` | that file instead of the listing |
| `/folder/` with `README.md` | the listing, then the rendered README below it |
| `/image.png`, `/doc.pdf`, `/clip.mp4` | the file with its real Content-Type |
| `/script.ts`, `/config.toml`, `/notes.txt` | `text/plain`, so the tab displays it instead of downloading |
| anything missing | a 404 page showing the path, a link home, and the parent listing |

A file argument switches to single-file mode: its parent becomes the root, so
relative links and images in the file resolve normally. Dotfiles such as
`.DS_Store` are hidden from listings.

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
- Raw HTML inside Markdown is not sanitized. Serve trusted trees only.

## Development

```bash
bun test        # tests live next to the code in src/
bun run start   # run the CLI from the checkout
```

`src/render.ts` builds pages and listings, `src/serve.ts` does routing and
content types, and `src/cli.ts` handles flags, the port, and opening the browser.

## License

MIT © 2026 Yuxi Wang
