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
    );
    expect(parseState(serializeState(original))).toEqual(original);
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
  test("renders a full report in groupByPath order", () => {
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
    expect(toMarkdown(s, "2026-11-27")).toBe(
      "# Review — 2026-11-27\n\n" +
        "## docs/plan.md\n> we'll migrate in Q3\n\nIs this still true?\n\n" +
        "## src/render.ts:401-405\n> line one of quote\n> line two\n\nThis allocates per render; cache it.\n",
    );
  });

  test("truncates after 20 quote lines, adds an ellipsis, and trims trailing whitespace", () => {
    const lines: string[] = [];
    for (let i = 1; i <= 23; i++) lines.push(`line ${i}`);
    const s = state(comment("1", "/big.txt", lineAnchor(1, 1, lines.join("\n") + "\n\n  "), "body", 1));

    const expected: string[] = [];
    for (let i = 1; i <= 20; i++) expected.push(`> line ${i}`);
    expected.push("> …");
    expect(toMarkdown(s, "2026-01-02")).toBe(
      "# Review — 2026-01-02\n\n## big.txt:1\n" + expected.join("\n") + "\n\nbody\n",
    );
  });

  test("blank quote lines become a bare marker", () => {
    const s = state(comment("1", "/a.txt", quoteAnchor("a\n\nb"), "note", 1));
    expect(toMarkdown(s, "2026-01-02")).toBe("# Review — 2026-01-02\n\n## a.txt\n> a\n>\n> b\n\nnote\n");
  });

  test("renders an empty state", () => {
    expect(toMarkdown(emptyState(), "2026-11-27")).toBe("# Review — 2026-11-27\n\n_No comments._\n");
  });
});
