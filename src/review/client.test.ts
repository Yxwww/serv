import { describe, expect, test } from "bun:test";
import {
  anchorFromSelection,
  commentIdFromHash,
  initReview,
  readState,
  rootPath,
  writeState,
  type StorageLike,
} from "./client";
import {
  STORAGE_KEY,
  addComment,
  emptyState,
  findComment,
  type ReviewComment,
  type ReviewState,
} from "./model";

// Range/TreeWalker need a real DOM, so selection anchoring is exercised through
// the offset-based seam that the browser wrapper feeds.
// Bun has no document, so importing client.ts does not auto-start initReview().

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function lineComment(): ReviewComment {
  return {
    id: "c1",
    path: "/a.ts",
    anchor: { kind: "lines", start: 2, end: 2, quote: "todo", selected: "todo" },
    body: "note",
    created: 1,
  };
}

describe("review state persistence", () => {
  test("round-trips comments through storage", () => {
    const storage = memoryStorage();
    const state = addComment(emptyState(), lineComment(), "c1", 1);
    expect(writeState(storage, state)).toBe(true);

    const reloaded = readState(storage);
    expect(reloaded.comments).toHaveLength(1);
    expect(reloaded.comments[0]!.body).toBe("note");
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
  });

  test("corrupt or unavailable storage reads as empty", () => {
    expect(readState(memoryStorage())).toEqual(emptyState());
    expect(readState(memoryStorage({ [STORAGE_KEY]: "{not json" }))).toEqual(emptyState());
    expect(
      readState({
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {},
      }),
    ).toEqual(emptyState());
  });

  test("reports a failed write so callers keep in-memory state", () => {
    const state = addComment(emptyState(), lineComment(), "c1", 1);
    expect(
      writeState(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        state,
      ),
    ).toBe(false);
  });

  test("resolves a comment id from the hash after reload", () => {
    const storage = memoryStorage();
    const state = addComment(emptyState(), lineComment(), "c1", 1);
    writeState(storage, state);
    const reloaded: ReviewState = readState(storage);
    expect(findComment(reloaded, commentIdFromHash("#c=c1")!)?.id).toBe("c1");
  });
});

describe("hash ids", () => {
  test("decodes escaped ids and keeps malformed ids usable", () => {
    expect(commentIdFromHash("#c=abc%20def")).toBe("abc def");
    expect(commentIdFromHash("#c=bad%ZZ")).toBe("bad%ZZ");
    expect(commentIdFromHash("#other")).toBeNull();
    expect(commentIdFromHash("")).toBeNull();
  });
});

describe("served root", () => {
  test("reads data-serv-root and defaults to empty", () => {
    const root = { body: { dataset: { servRoot: "/home/u/proj & src" } } } as unknown as Document;
    const bare = { body: { dataset: {} } } as unknown as Document;
    expect(rootPath(root)).toBe("/home/u/proj & src");
    expect(rootPath(bare)).toBe("");
  });
});

describe("selection anchors", () => {
  test("maps a source selection to whole lines with raw text", () => {
    const text = "one\ntwo\nthree";
    const anchor = anchorFromSelection({ kind: "source", text, start: 4, end: 7 })!;
    expect(anchor).toMatchObject({
      kind: "lines",
      start: 2,
      end: 2,
      quote: "two",
      excerpt: "two",
      selected: "two",
    });
  });

  test("keeps the full line and the exact selected text apart", () => {
    const text = "const a = 1; // note";
    const start = text.indexOf("note");
    const anchor = anchorFromSelection({ kind: "source", text, start, end: text.length })!;
    expect(anchor).toMatchObject({
      kind: "lines",
      start: 1,
      end: 1,
      quote: "note",
      excerpt: text,
      selected: "note",
    });
  });

  test("maps a rendered table cell back to its raw source lines", () => {
    const source = "| id | status |\n| --- | --- |\n| 1 | todo |";
    const rendered = "idstatus1todo";
    const start = rendered.indexOf("todo");
    const anchor = anchorFromSelection({
      kind: "prose",
      text: rendered,
      start,
      end: start + 4,
      source,
    })!;
    expect(anchor.kind).toBe("quote");
    if (anchor.kind !== "quote") return;
    expect(anchor.lines).toEqual({ start: 3, end: 3 });
    expect(anchor.excerpt).toBe("| 1 | todo |");
    expect(anchor.selected).toBe("todo");
    expect(anchor.quote).toBe("todo");
  });

  test("maps a heading selection to the raw Markdown text", () => {
    const source = "## p0-quick-wins — L1 quick wins";
    const rendered = "p0-quick-wins — L1 quick wins";
    const start = rendered.indexOf("L1 quick wins");
    const anchor = anchorFromSelection({
      kind: "prose",
      text: rendered,
      start,
      end: rendered.length,
      source,
    })!;
    expect(anchor.kind).toBe("quote");
    if (anchor.kind !== "quote") return;
    expect(anchor.lines).toEqual({ start: 1, end: 1 });
    expect(anchor.excerpt).toBe(source);
    expect(anchor.selected).toBe("L1 quick wins");
  });

  test("caps excerpts by line count and selections by characters", () => {
    const lines = Array.from({ length: 45 }, (_, i) => `line ${i + 1}`).join("\n");
    const sel = anchorFromSelection({ kind: "source", text: lines, start: 0, end: lines.length })!;
    expect(sel.excerpt!.split("\n")).toHaveLength(40);

    const long = "x".repeat(2500);
    const wide = anchorFromSelection({ kind: "source", text: long, start: 0, end: long.length })!;
    expect(wide.quote.length).toBe(2000);
    expect(wide.selected!.length).toBe(2000);

    const hugeLine = "y".repeat(500_000);
    const huge = anchorFromSelection({
      kind: "source",
      text: hugeLine,
      start: 0,
      end: hugeLine.length,
    })!;
    expect(huge.excerpt!.length).toBe(2000);
  });

  test("the character cap does not split a surrogate pair", () => {
    const text = "x".repeat(1999) + "😀tail";
    const anchor = anchorFromSelection({ kind: "source", text, start: 0, end: text.length })!;
    expect(anchor.selected).toBe("x".repeat(1999));
    expect(anchor.quote).toBe("x".repeat(1999));
  });

  test("rejects an empty or whitespace-only selection", () => {
    expect(anchorFromSelection({ kind: "source", text: "abc", start: 1, end: 1 })).toBeNull();
    expect(anchorFromSelection({ kind: "source", text: "a b", start: 1, end: 2 })).toBeNull();
  });
});

describe("initReview seam", () => {
  test("accepts an injected document and storage", () => {
    const doc = { getElementById: () => null } as unknown as Document;
    expect(() => initReview(doc, memoryStorage(), { writeText: async () => {} })).not.toThrow();
  });
});
