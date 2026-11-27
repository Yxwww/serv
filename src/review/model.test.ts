import { describe, expect, test } from "bun:test";
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
  mapToSourceRange,
  parseState,
  removeComment,
  serializeState,
  toMarkdown,
  updateComment,
  type Anchor,
  type LineAnchor,
  type QuoteAnchor,
  type ReviewComment,
  type ReviewState,
} from "./model";

function lineAnchor(start: number, end: number, quote = "x"): LineAnchor {
  return { kind: "lines", start, end, quote };
}

function quoteAnchor(quote: string, prefix = "", suffix = ""): QuoteAnchor {
  return { kind: "quote", quote, prefix, suffix };
}

function comment(id: string, path: string, anchor: Anchor, body = "", created = 0): ReviewComment {
  return { id, path, anchor, body, created };
}

function state(...comments: ReviewComment[]): ReviewState {
  return { v: 1, comments };
}

describe("parseState", () => {
  test("never throws; garbage, wrong versions and malformed entries are dropped", () => {
    expect(STORAGE_KEY).toBe("serv:review");
    expect(parseState(null)).toEqual(emptyState());
    expect(parseState("")).toEqual(emptyState());
    expect(parseState("{")).toEqual(emptyState());
    expect(parseState("[]")).toEqual(emptyState());
    expect(parseState('{"v":2,"comments":[]}')).toEqual(emptyState());
    expect(parseState('{"v":1,"comments":"nope"}')).toEqual(emptyState());

    const valid = comment("keep", "/a.ts", lineAnchor(1, 2, "hi"), "body", 7);
    const raw = JSON.stringify({
      v: 1,
      comments: [
        valid,
        { id: "bad-start", path: "/a.ts", anchor: { kind: "lines", start: 0, end: 1, quote: "x" }, body: "", created: 1 },
        { id: "bad-kind", path: "/a.ts", anchor: { kind: "nope" }, body: "", created: 1 },
        { id: "bad-created", path: "/a.ts", anchor: quoteAnchor("q"), body: "", created: "now" },
        { path: "/a.ts", anchor: quoteAnchor("q"), body: "", created: 1 },
      ],
    });
    expect(parseState(raw)).toEqual({ v: 1, comments: [valid] });
  });

  test("round-trips a serialized state", () => {
    const original = state(
      comment("a", "/a.ts", lineAnchor(3, 3), "hi", 1),
      comment("b", "/b.md", quoteAnchor("q", "pre", "suf"), "", 2),
      comment(
        "c",
        "/c.md",
        {
          kind: "quote",
          quote: "q",
          prefix: "pre",
          suffix: "suf",
          lines: { start: 4, end: 6 },
          excerpt: "| a | b |",
          selected: "a",
        },
        "",
        3,
      ),
    );
    expect(parseState(serializeState(original))).toEqual(original);
  });

  test("keeps old line and quote anchors without excerpts", () => {
    const comments = [
      comment("line", "/a.ts", lineAnchor(1, 2, "x"), "", 1),
      comment("quote", "/a.md", quoteAnchor("q", "p", "s"), "", 2),
    ];
    expect(parseState(JSON.stringify({ v: 1, comments }))).toEqual({ v: 1, comments });
  });

  test("accepts optional source lines and excerpt, rejecting malformed values", () => {
    const withMeta: QuoteAnchor = {
      kind: "quote",
      quote: "q",
      prefix: "p",
      suffix: "s",
      lines: { start: 2, end: 4 },
      excerpt: "| a |\n| b |",
      selected: "a",
    };
    const raw = JSON.stringify({
      v: 1,
      comments: [
        comment("good", "/a.md", withMeta, "body", 1),
        {
          id: "bad-lines",
          path: "/a.md",
          anchor: { kind: "quote", quote: "q", prefix: "", suffix: "", lines: { start: 0, end: 1 } },
          body: "",
          created: 1,
        },
        {
          id: "bad-excerpt",
          path: "/a.md",
          anchor: { kind: "quote", quote: "q", prefix: "", suffix: "", excerpt: 3 },
          body: "",
          created: 1,
        },
        {
          id: "bad-line-excerpt",
          path: "/a.ts",
          anchor: { kind: "lines", start: 1, end: 1, quote: "x", excerpt: 3 },
          body: "",
          created: 1,
        },
        {
          id: "bad-selected",
          path: "/a.md",
          anchor: { kind: "quote", quote: "q", prefix: "", suffix: "", selected: 3 },
          body: "",
          created: 1,
        },
      ],
    });
    expect(parseState(raw)).toEqual({ v: 1, comments: [comment("good", "/a.md", withMeta, "body", 1)] });
  });
});

describe("state updates", () => {
  test("add, update and remove return new states and leave the input alone", () => {
    const anchor = quoteAnchor("target");
    const base = state(comment("a", "/a.ts", lineAnchor(1, 1, "one"), "first", 1));
    const snapshot = structuredClone(base);

    const added = addComment(base, { path: "/b.md", anchor, body: "second" }, "b", 42);
    expect(added).not.toBe(base);
    expect(added.comments).toEqual([
      comment("a", "/a.ts", lineAnchor(1, 1, "one"), "first", 1),
      comment("b", "/b.md", quoteAnchor("target"), "second", 42),
    ]);
    expect(added.comments[1]!.anchor).not.toBe(anchor);
    expect(base).toEqual(snapshot);

    const updated = updateComment(added, "b", "edited");
    expect(updated.comments[1]!.body).toBe("edited");
    expect(added.comments[1]!.body).toBe("second");
    expect(updateComment(added, "missing", "x")).toEqual(added);

    const removed = removeComment(updated, "b");
    expect(removed.comments).toEqual([comment("a", "/a.ts", lineAnchor(1, 1, "one"), "first", 1)]);
    expect(removeComment(updated, "missing")).toEqual(updated);
    expect(findComment(updated, "b")!.body).toBe("edited");
    expect(findComment(updated, "missing")).toBeUndefined();
  });
});

describe("groupByPath", () => {
  test("puts the current file first, sorts other paths, and orders comments in a group", () => {
    const s = state(
      comment("b-line-20", "/b.md", lineAnchor(20, 20), "", 5),
      comment("a-quote-30", "/a.md", quoteAnchor("q"), "", 30),
      comment("b-quote-10", "/b.md", quoteAnchor("q"), "", 10),
      comment("b-line-5", "/b.md", lineAnchor(5, 5), "", 1),
      comment("a-line-9", "/a.md", lineAnchor(9, 9), "", 2),
      comment("a-quote-20", "/a.md", quoteAnchor("q"), "", 20),
    );

    const plain = groupByPath(s);
    expect(plain.map((group) => group.path)).toEqual(["/a.md", "/b.md"]);
    expect(plain[0]!.comments.map((c) => c.id)).toEqual(["a-line-9", "a-quote-20", "a-quote-30"]);
    expect(plain[1]!.comments.map((c) => c.id)).toEqual(["b-line-5", "b-line-20", "b-quote-10"]);

    expect(groupByPath(s, "/b.md").map((group) => group.path)).toEqual(["/b.md", "/a.md"]);
    expect(groupByPath(s, "/missing").map((group) => group.path)).toEqual(["/a.md", "/b.md"]);
  });

  test("orders mixed anchor kinds by start line, unlocatable quotes last", () => {
    const s = state(
      comment("quote-none", "/a.md", quoteAnchor("q"), "", 1),
      comment("line-12", "/a.md", lineAnchor(12, 12), "", 2),
      comment(
        "quote-5",
        "/a.md",
        { kind: "quote", quote: "q", prefix: "", suffix: "", lines: { start: 5, end: 5 } },
        "",
        3,
      ),
      comment("line-3", "/a.md", lineAnchor(3, 4), "", 4),
      comment(
        "quote-12",
        "/a.md",
        { kind: "quote", quote: "q", prefix: "", suffix: "", lines: { start: 12, end: 14 } },
        "",
        5,
      ),
    );
    const order = ["line-3", "quote-5", "line-12", "quote-12", "quote-none"];
    expect(groupByPath(s).map((group) => group.comments.map((c) => c.id))).toEqual([order]);
    expect(groupByPath(s, "/a.md")[0]!.comments.map((c) => c.id)).toEqual(order);
  });
});

describe("lineRangeFromOffsets", () => {
  test("maps offsets to 1-based inclusive lines; a trailing newline stays on its line", () => {
    const text = "one\ntwo\nthree";
    expect(lineRangeFromOffsets(text, 0, 3)).toEqual({ start: 1, end: 1 });
    expect(lineRangeFromOffsets(text, 4, 7)).toEqual({ start: 2, end: 2 });
    expect(lineRangeFromOffsets(text, 0, 13)).toEqual({ start: 1, end: 3 });
    expect(lineRangeFromOffsets(text, 8, 13)).toEqual({ start: 3, end: 3 });
    expect(lineRangeFromOffsets(text, 5, 5)).toEqual({ start: 2, end: 2 });
    expect(lineRangeFromOffsets(text, 0, 4)).toEqual({ start: 1, end: 1 });
    expect(lineRangeFromOffsets("a\n", 0, 2)).toEqual({ start: 1, end: 1 });
    expect(lineRangeFromOffsets("", 0, 0)).toEqual({ start: 1, end: 1 });
  });
});

describe("lineOffsets", () => {
  test("returns the character span for inclusive lines and clamps out-of-range lines", () => {
    const text = "alpha\nbeta\ngamma";
    expect(lineOffsets(text, 1, 1)).toEqual({ start: 0, end: 5 });
    expect(lineOffsets(text, 2, 2)).toEqual({ start: 6, end: 10 });
    expect(lineOffsets(text, 3, 3)).toEqual({ start: 11, end: 16 });
    expect(lineOffsets(text, 1, 3)).toEqual({ start: 0, end: 16 });
    expect(lineOffsets(text, 0, 99)).toEqual({ start: 0, end: 16 });
    expect(lineOffsets("abc", 1, 1)).toEqual({ start: 0, end: 3 });
  });

  test("round-trips with lineRangeFromOffsets", () => {
    const text = "alpha\nbeta\ngamma";
    const first = lineOffsets(text, 1, 1);
    const across = lineOffsets(text, 2, 3);
    const last = lineOffsets(text, 3, 3);
    expect(lineRangeFromOffsets(text, first.start, first.end)).toEqual({ start: 1, end: 1 });
    expect(lineRangeFromOffsets(text, across.start, across.end)).toEqual({ start: 2, end: 3 });
    expect(lineRangeFromOffsets(text, last.start, last.end)).toEqual({ start: 3, end: 3 });
  });
});

describe("mapToSourceRange", () => {
  test("maps table cells, emphasis, code and link text to source lines", () => {
    const table = "| id | status |\n| --- | --- |\n| 1 | todo |\n| 2 | done |";
    expect(mapToSourceRange(table, "idstatus")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(table, "1todo")!.lines).toEqual({ start: 3, end: 3 });
    expect(mapToSourceRange(table, "2done")!.lines).toEqual({ start: 4, end: 4 });

    const prose = "This is **bold** and `code` with a [link](https://example.com/a_b).";
    expect(mapToSourceRange(prose, "bold")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(prose, "code")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(prose, "link")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(prose, "This is bold and code with a link.")!.lines).toEqual({ start: 1, end: 1 });
  });

  test("maps headings and returns null when nothing matches", () => {
    const md = "## Requirements\n\nBun **1.3.8 or newer**.";
    expect(mapToSourceRange(md, "Requirements")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(md, "Bun 1.3.8 or newer")!.lines).toEqual({ start: 3, end: 3 });
    expect(mapToSourceRange(md, "absent")).toBeNull();
    expect(mapToSourceRange(md, "")).toBeNull();
  });

  test("uses the hint to disambiguate repeated text", () => {
    const text = "target alpha\ntarget beta";
    expect(mapToSourceRange(text, "target")!.lines).toEqual({ start: 1, end: 1 });
    expect(mapToSourceRange(text, "target", 13)!.lines).toEqual({ start: 2, end: 2 });
  });

  test("exposes the raw source slice", () => {
    const table = "| id | status |\n| --- | --- |\n| 1 | todo |";
    const range = mapToSourceRange(table, "1todo")!;
    expect(range.lines).toEqual({ start: 3, end: 3 });
    expect(table.slice(range.start, range.end)).toBe("1 | todo");
  });
});

describe("findQuote", () => {
  test("picks the occurrence whose context matches, falling back to the first", () => {
    const text = "one target two\nxxx target yyy\n";
    expect(findQuote(text, quoteAnchor("target", "xxx ", " yyy"))).toEqual({ start: 19, end: 25 });
    expect(findQuote(text, quoteAnchor("target"))).toEqual({ start: 4, end: 10 });

    // Equal context lets the earliest occurrence win.
    expect(findQuote("a target b a target b", quoteAnchor("target", "a ", " b"))).toEqual({ start: 2, end: 8 });
  });

  test("returns null for a missing or empty quote", () => {
    const text = "one target two";
    expect(findQuote(text, quoteAnchor("absent", "one ", " two"))).toBeNull();
    expect(findQuote(text, quoteAnchor(""))).toBeNull();
  });

  test("makeQuoteAnchor captures the requested context window", () => {
    expect(makeQuoteAnchor("0123456789 target ABCDEFGHIJ", 11, 17, 5)).toEqual(
      quoteAnchor("target", "6789 ", " ABCD"),
    );
    expect(makeQuoteAnchor("short", 1, 3)).toEqual(quoteAnchor("ho", "s", "rt"));
  });
});

describe("toMarkdown", () => {
  test("renders numbered file:line entries in groupByPath order with a root", () => {
    const s = state(
      comment(
        "1",
        "/src/render.ts",
        lineAnchor(401, 405, "line one of quote\nline two"),
        "This allocates per render; cache it.",
        1,
      ),
      comment("2", "/docs/plan.md", quoteAnchor("we'll migrate in Q3"), "Is this still true?", 2),
    );
    expect(toMarkdown(s, "2026-11-27", "/home/u/proj")).toBe(
      "# Comments — 2026-11-27\n" +
        "Root: /home/u/proj\n\n" +
        "### 1. docs/plan.md (no line match)\n> we'll migrate in Q3\n\n" +
        "**Comment:** Is this still true?\n\n" +
        "### 2. src/render.ts:401-405\n> line one of quote\n> line two\n\n" +
        "**Comment:** This allocates per render; cache it.\n",
    );
  });

  test("old preview entries without selected omit the Selected line", () => {
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: "idstatus1todo",
      prefix: "",
      suffix: "",
      lines: { start: 2, end: 4 },
      excerpt: "| id | status |\n| --- | --- |\n| 1 | todo |",
    };
    const s = state(comment("1", "/views/PLAN.md", anchor, "Looks right.", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. views/PLAN.md:2-4\n> | id | status |\n> | --- | --- |\n> | 1 | todo |\n\n" +
        "**Comment:** Looks right.\n",
    );
  });

  test("old source entries fall back to quote for Selected", () => {
    const anchor: LineAnchor = {
      kind: "lines",
      start: 2,
      end: 2,
      quote: "todo",
      excerpt: "- Status: **todo**",
    };
    const s = state(comment("1", "/a.md", anchor, "note", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. a.md:2\n> - Status: **todo**\n" +
        'Selected: "todo"\n\n' +
        "**Comment:** note\n",
    );
  });

  test("omits Selected when the whole table range was selected", () => {
    const source = "| id | status |\n| --- | --- |\n| 1 | todo |";
    const range = mapToSourceRange(source, "idstatus1todo")!;
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: "idstatus1todo",
      prefix: "",
      suffix: "",
      lines: range.lines,
      excerpt: source,
      selected: source.slice(range.start, range.end),
    };
    const s = state(comment("1", "/views/PLAN.md", anchor, "Looks right.", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. views/PLAN.md:1-3\n> | id | status |\n> | --- | --- |\n> | 1 | todo |\n\n" +
        "**Comment:** Looks right.\n",
    );
  });

  test("omits Selected for full table rows with link destinations", () => {
    const source =
      "| id | tickets |\n| --- | --- |\n| a | [SDK-1](https://x/1); [SDK-2](https://x/2) |";
    const range = mapToSourceRange(source, "idticketsaSDK-1; SDK-2")!;
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: "idticketsaSDK-1; SDK-2",
      prefix: "",
      suffix: "",
      lines: range.lines,
      excerpt: source,
      selected: source.slice(range.start, range.end),
    };
    const s = state(comment("1", "/views/PLAN.md", anchor, "note", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. views/PLAN.md:1-3\n" +
        "> | id | tickets |\n> | --- | --- |\n> | a | [SDK-1](https://x/1); [SDK-2](https://x/2) |\n\n" +
        "**Comment:** note\n",
    );
  });

  test("uses the raw source slice for a partial bold selection", () => {
    const source = "| Status | **todo** |";
    const range = mapToSourceRange(source, "todo")!;
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: "todo",
      prefix: "",
      suffix: "",
      lines: { start: 1, end: 1 },
      excerpt: source,
      selected: source.slice(range.start, range.end),
    };
    const s = state(comment("1", "/views/PLAN.md", anchor, "note", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. views/PLAN.md:1\n> | Status | **todo** |\n" +
        'Selected: "todo"\n\n' +
        "**Comment:** note\n",
    );
  });

  test("uses the raw source slice for a partial heading selection", () => {
    const source = "## p0-quick-wins — L1 quick wins";
    const range = mapToSourceRange(source, "L1 quick wins")!;
    const anchor: QuoteAnchor = {
      kind: "quote",
      quote: "L1 quick wins",
      prefix: "",
      suffix: "",
      lines: { start: 1, end: 1 },
      excerpt: source,
      selected: source.slice(range.start, range.end),
    };
    const s = state(comment("1", "/views/PLAN.md", anchor, "note", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. views/PLAN.md:1\n> ## p0-quick-wins — L1 quick wins\n" +
        'Selected: "L1 quick wins"\n\n' +
        "**Comment:** note\n",
    );
  });

  test("shows the full source line and a partial selection", () => {
    const anchor: LineAnchor = {
      kind: "lines",
      start: 12,
      end: 12,
      quote: "build + health in one step",
      excerpt:
        "- `bun run tools/refresh.ts` — build + health in one step (--watch: reruns on data/ and venues/l2/ changes)",
      selected: "build + health in one step",
    };
    const s = state(comment("1", "/README.md", anchor, "note", 1));
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Comments — 2026-11-27\n\n" +
        "### 1. README.md:12\n" +
        "> - `bun run tools/refresh.ts` — build + health in one step (--watch: reruns on data/ and venues/l2/ changes)\n" +
        'Selected: "build + health in one step"\n\n' +
        "**Comment:** note\n",
    );
  });

  test("omits Selected when it matches the quoted lines", () => {
    const anchor: LineAnchor = {
      kind: "lines",
      start: 3,
      end: 3,
      quote: "const a = 1;",
      excerpt: "const a = 1;",
      selected: "const a = 1;",
    };
    const s = state(comment("1", "/a.ts", anchor, "body", 1));
    expect(toMarkdown(s, "2026-01-02")).toBe(
      "# Comments — 2026-01-02\n\n" +
        "### 1. a.ts:3\n> const a = 1;\n\n" +
        "**Comment:** body\n",
    );
  });

  test("caps Selected at 200 characters", () => {
    const long = "x".repeat(250);
    const anchor: LineAnchor = {
      kind: "lines",
      start: 1,
      end: 1,
      quote: long,
      excerpt: `prefix ${long}`,
      selected: long,
    };
    const s = state(comment("1", "/a.txt", anchor, "body", 1));
    expect(toMarkdown(s, "2026-01-02")).toContain(`Selected: "${"x".repeat(200)}…"`);
  });

  test("shows forty quote lines whole and caps the rest", () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
    const forty = Array.from({ length: 40 }, (_, i) => `> line ${i + 1}`).join("\n");
    expect(toMarkdown(state(comment("1", "/a.txt", lineAnchor(1, 1, make(40)), "body", 1)), "2026-01-02")).toBe(
      `# Comments — 2026-01-02\n\n### 1. a.txt:1\n${forty}\n\n**Comment:** body\n`,
    );
    expect(toMarkdown(state(comment("1", "/a.txt", lineAnchor(1, 1, make(41)), "body", 1)), "2026-01-02")).toBe(
      `# Comments — 2026-01-02\n\n### 1. a.txt:1\n${forty}\n> … (1 more lines)\n\n**Comment:** body\n`,
    );
  });

  test("blank quote lines become a bare marker and trailing whitespace is trimmed", () => {
    const s = state(comment("1", "/a.txt", quoteAnchor("a  \n\nb\n"), "note", 1));
    expect(toMarkdown(s, "2026-01-02")).toBe(
      "# Comments — 2026-01-02\n\n" +
        "### 1. a.txt (no line match)\n> a\n>\n> b\n\n" +
        "**Comment:** note\n",
    );
  });

  test("keeps multi-line bodies verbatim except structural markers", () => {
    const s = state(comment("1", "/a.txt", lineAnchor(2, 2, "x"), "first\n## fake\n> quote", 1));
    expect(toMarkdown(s, "2026-01-02")).toBe(
      "# Comments — 2026-01-02\n\n" +
        "### 1. a.txt:2\n> x\n\n" +
        "**Comment:** first\n\\## fake\n\\> quote\n",
    );
  });

  test("a forged comment body cannot inject a heading or quote", () => {
    const body = "before\n\n### 99. fake.md:1\n> injected\n  > indented";
    const out = toMarkdown(state(comment("1", "/a.txt", lineAnchor(2, 2, "x"), body, 1)), "2026-01-02");
    expect(out).not.toContain("\n### 99.");
    expect(out).toContain("\n\\### 99. fake.md:1\n\\> injected\n  \\> indented");
  });

  test("sanitizes newlines in the displayed path and root", () => {
    const s = state(comment("1", "/evil\n### 9. injected", lineAnchor(1, 1, "x"), "body", 1));
    const out = toMarkdown(s, "2026-01-02", "/root\r### 9. root");
    expect(out).toBe(
      "# Comments — 2026-01-02\n" +
        "Root: /root ### 9. root\n\n" +
        "### 1. evil ### 9. injected:1\n> x\n\n" +
        "**Comment:** body\n",
    );
    expect(out).not.toContain("\n### 9.");
  });

  test("a lone CR in a body cannot inject structure", () => {
    const body = "first\r### 99. fake\r> quote";
    const out = toMarkdown(state(comment("1", "/a.txt", lineAnchor(2, 2, "x"), body, 1)), "2026-01-02");
    expect(out).toContain("**Comment:** first\n\\### 99. fake\n\\> quote\n");
    expect(out).not.toContain("\r");
  });

  test("reports lines hidden by the creation-time excerpt cap", () => {
    const excerpt = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
    const anchor: LineAnchor = {
      kind: "lines",
      start: 1,
      end: 45,
      quote: excerpt,
      excerpt,
      selected: excerpt,
    };
    const out = toMarkdown(state(comment("1", "/a.txt", anchor, "body", 1)), "2026-01-02");
    expect(out).toContain("> … (5 more lines)");
  });

  test("escapes quotes in Selected", () => {
    const anchor: LineAnchor = {
      kind: "lines",
      start: 1,
      end: 1,
      quote: "todo",
      excerpt: 'before say "todo" after',
      selected: 'say "todo"',
    };
    const out = toMarkdown(state(comment("1", "/a.txt", anchor, "note", 1)), "2026-01-02");
    expect(out).toContain('Selected: "say \\"todo\\""');
  });

  test("renders an empty state with and without a root", () => {
    expect(toMarkdown(emptyState(), "2026-11-27")).toBe("# Comments — 2026-11-27\n\n_No comments._\n");
    expect(toMarkdown(emptyState(), "2026-11-27", "/tmp/x")).toBe(
      "# Comments — 2026-11-27\nRoot: /tmp/x\n\n_No comments._\n",
    );
  });
});
