import { describe, expect, test } from "bun:test";
import { Fzf } from "fzf";
import { PRE_PAINT } from "./render";
import { dispatchKey, highlightSegments, initSearch, originalPositions, resultHref, type Binding } from "./search";

type FakeElement = {
  tagName: string;
  className: string;
  id: string;
  title: string;
  hidden: boolean;
  value: string;
  innerHTML: string;
  textContent: string;
  attrs: Map<string, string>;
  children: FakeElement[];
  parent: FakeElement | null;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    contains(name: string): boolean;
    toggle(name: string, on?: boolean): void;
  };
  append(...items: (FakeElement | string)[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (event: any) => void): void;
  focus(): void;
  blur(): void;
  click(): void;
  scrollIntoView(): void;
  querySelectorAll(selector: string): FakeElement[];
};

function hasClass(node: FakeElement, name: string): boolean {
  return node.className.split(/\s+/).includes(name);
}

function element(tagName = "div"): FakeElement {
  let text = "";
  const listeners = new Map<string, ((event: any) => void)[]>();
  const node = {
    tagName: tagName.toUpperCase(),
    className: "",
    id: "",
    title: "",
    hidden: false,
    value: "",
    innerHTML: "",
    attrs: new Map<string, string>(),
    children: [] as FakeElement[],
    parent: null as FakeElement | null,
    classList: {
      add(name: string) {
        if (!hasClass(node, name)) node.className = node.className ? `${node.className} ${name}` : name;
      },
      remove(name: string) {
        node.className = node.className.split(/\s+/).filter((part) => part && part !== name).join(" ");
      },
      contains(name: string) {
        return hasClass(node, name);
      },
      toggle(name: string, on?: boolean) {
        const want = on ?? !hasClass(node, name);
        if (want) node.classList.add(name);
        else node.classList.remove(name);
      },
    },
    get textContent(): string {
      return text + node.children.map((child) => child.textContent).join("");
    },
    set textContent(value: string) {
      text = String(value);
      node.children.length = 0;
    },
    append(...items: (FakeElement | string)[]) {
      for (const item of items) {
        if (typeof item === "string") {
          text += item;
          continue;
        }
        if (item.tagName === "#FRAGMENT") {
          node.append(...item.children.splice(0));
          continue;
        }
        item.parent = node;
        node.children.push(item);
      }
    },
    setAttribute(name: string, value: string) {
      node.attrs.set(name, String(value));
    },
    getAttribute(name: string) {
      return node.attrs.get(name) ?? null;
    },
    hasAttribute(name: string) {
      return node.attrs.has(name);
    },
    removeAttribute(name: string) {
      node.attrs.delete(name);
    },
    addEventListener(type: string, fn: (event: any) => void) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(fn);
      listeners.set(type, handlers);
    },
    focus() {},
    blur() {},
    click() {
      node.attrs.set("clicked", String(Number(node.attrs.get("clicked") ?? 0) + 1));
    },
    scrollIntoView() {},
    querySelectorAll(selector: string) {
      const wanted = selector.startsWith(".") ? selector.slice(1) : "";
      const found: FakeElement[] = [];
      const walk = (parent: FakeElement) => {
        for (const child of parent.children) {
          if (wanted && hasClass(child, wanted)) found.push(child);
          walk(child);
        }
      };
      walk(node);
      return found;
    },
  } as FakeElement;
  return node;
}

function findById(root: FakeElement, id: string): FakeElement | undefined {
  for (const child of root.children) {
    if (child.id === id) return child;
    const nested = findById(child, id);
    if (nested) return nested;
  }
  return undefined;
}

function fakeDocument(rows: FakeElement[] = [], opts: { md?: "source" | "rendered" } = {}) {
  const html = element("html");
  const body = element("body");
  const palette = element("div");
  palette.hidden = true;
  const input = element("input");
  const list = element("ul");
  const status = element("div");
  const button = element("button");
  const mdRoot = opts.md ? element("div") : null;
  const mdLinks = {
    rendered: element("a"),
    source: element("a"),
  };
  mdLinks.rendered.attrs.set("data-md-link", "rendered");
  mdLinks.source.attrs.set("data-md-link", "source");
  if (opts.md) html.className = `serv-md-page serv-md-${opts.md}`;
  const byId = new Map<string, FakeElement>([
    ["serv-palette", palette],
    ["serv-search-input", input],
    ["serv-search-list", list],
    ["serv-search-status", status],
  ]);
  const listeners = new Map<string, (event: any) => void>();
  const doc = {
    documentElement: html,
    body,
    activeElement: null,
    getElementById: (id: string) => byId.get(id) ?? findById(list, id) ?? null,
    querySelector: (selector: string) => {
      if (selector === "[data-serv-hidden-count]") return button;
      if (selector === "[data-md-view]") return mdRoot;
      const link = /^\[data-md-link="(source|rendered)"\]$/.exec(selector);
      return link ? mdLinks[link[1] as "source" | "rendered"] : null;
    },
    querySelectorAll: (selector: string) => (selector === ".listing tbody tr" ? rows : []),
    createElement: (tag: string) => element(tag),
    createDocumentFragment: () => element("#fragment"),
    addEventListener(type: string, fn: (event: any) => void) {
      listeners.set(type, fn);
    },
  };
  return {
    doc: doc as unknown as Document,
    html,
    body,
    palette,
    input,
    list,
    status,
    button,
    mdLinks,
    keydown: (event: KeyboardEvent) => listeners.get("keydown")?.(event),
  };
}

function row(...attrs: string[]): FakeElement {
  const node = element("tr");
  for (const attr of attrs) node.attrs.set(attr, "");
  return node;
}

function stubFetch(response: () => Promise<unknown>): () => void {
  const saved = globalThis.fetch;
  globalThis.fetch = (() => response()) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = saved;
  };
}

function stubStorage(): { store: Map<string, string>; restore: () => void } {
  const store = new Map<string, string>();
  const saved = (globalThis as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, String(value)),
      removeItem: (key: string) => store.delete(key),
      clear: () => store.clear(),
    },
  });
  return {
    store,
    restore: () => {
      if (saved) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: saved });
      else delete (globalThis as { localStorage?: Storage }).localStorage;
    },
  };
}

type Fake = {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  target?: unknown;
};

function press(opts: Fake) {
  let prevented = 0;
  const event = {
    key: opts.key,
    shiftKey: opts.shiftKey ?? false,
    metaKey: opts.metaKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    altKey: opts.altKey ?? false,
    isComposing: opts.isComposing ?? false,
    keyCode: opts.keyCode ?? 0,
    target: opts.target ?? { tagName: "BODY" },
    preventDefault: () => {
      prevented++;
    },
  } as unknown as KeyboardEvent;
  return { event, prevented: () => prevented };
}

describe("highlighting", () => {
  test("tracks UTF-16 offsets for astral names", () => {
    const emoji = "a😀b.md";
    const [b] = new Fzf([emoji]).find("b");
    expect(originalPositions(emoji, b!.positions)).toEqual(new Set([3]));
    expect(highlightSegments(emoji, originalPositions(emoji, b!.positions))).toEqual([
      { text: "a😀", hit: false },
      { text: "b", hit: true },
      { text: ".md", hit: false },
    ]);

    const [face] = new Fzf([emoji]).find("😀");
    expect(highlightSegments(emoji, originalPositions(emoji, face!.positions))).toEqual([
      { text: "a", hit: false },
      { text: "😀", hit: true },
      { text: "b.md", hit: false },
    ]);

    const flag = "flag🇫🇷.md";
    const [fr] = new Fzf([flag]).find("🇫🇷");
    expect(highlightSegments(flag, originalPositions(flag, fr!.positions))).toEqual([
      { text: "flag", hit: false },
      { text: "🇫🇷", hit: true },
      { text: ".md", hit: false },
    ]);
  });

  test("maps fzf's normalized positions back to a decomposed name", () => {
    const name = "café.md";

    const [accent] = new Fzf([name]).find("é");
    expect(originalPositions(name, accent!.positions)).toEqual(new Set([3, 4]));
    expect(highlightSegments(name, originalPositions(name, accent!.positions))).toEqual([
      { text: "caf", hit: false },
      { text: "é", hit: true },
      { text: ".md", hit: false },
    ]);

    const [prefix] = new Fzf([name]).find("cafe");
    expect(originalPositions(name, prefix!.positions)).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});

describe("resultHref", () => {
  test("encodes each path segment and keeps a folder's slash", () => {
    expect(resultHref("a b/<x>.md")).toBe("/a%20b/%3Cx%3E.md");
    expect(resultHref("sub/")).toBe("/sub/");
    expect(resultHref("sub/a#b.md")).toBe("/sub/a%23b.md");
  });
});

describe("dispatchKey", () => {
  test("applies modifiers, editable fields, guards and preventDefault once", () => {
    const ran: string[] = [];
    const bindings: Binding[] = [
      { key: "/", run: () => ran.push("slash") },
      { key: "k", mod: true, allowInEditable: true, run: () => ran.push("mod-k") },
      { key: "h", shift: true, run: () => ran.push("shift-h") },
      { key: "arrowdown", when: () => false, run: () => ran.push("never") },
    ];
    const editable = { tagName: "INPUT" };

    let hit = press({ key: "/", target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    expect(hit.prevented()).toBe(0);

    hit = press({ key: "/" });
    expect(dispatchKey(hit.event, bindings)).toBe(true);
    expect(ran).toEqual(["slash"]);
    expect(hit.prevented()).toBe(1);

    // A modifier binding is allowed in a field; an unmodified key is not.
    hit = press({ key: "k", ctrlKey: true, target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(true);
    expect(ran).toEqual(["slash", "mod-k"]);
    hit = press({ key: "k", target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(false);

    // An unexpected modifier and the wrong shift state do not match.
    hit = press({ key: "/", ctrlKey: true });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    hit = press({ key: "h" });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    hit = press({ key: "H", shiftKey: true });
    expect(dispatchKey(hit.event, bindings)).toBe(true);
    expect(ran).toEqual(["slash", "mod-k", "shift-h"]);

    // Alt is never claimed, and a false guard skips.
    hit = press({ key: "/", altKey: true });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    hit = press({ key: "arrowdown" });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
  });

  test("leaves IME composition keys to the input method", () => {
    const ran: string[] = [];
    const bindings: Binding[] = [
      { key: "enter", allowInEditable: true, run: () => ran.push("enter") },
      { key: "escape", allowInEditable: true, run: () => ran.push("escape") },
    ];
    const editable = { tagName: "INPUT" };

    let hit = press({ key: "Enter", isComposing: true, target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    expect(hit.prevented()).toBe(0);
    expect(ran).toEqual([]);

    hit = press({ key: "Escape", keyCode: 229, target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(false);
    expect(ran).toEqual([]);

    hit = press({ key: "Enter", target: editable });
    expect(dispatchKey(hit.event, bindings)).toBe(true);
    expect(ran).toEqual(["enter"]);
  });

  test("a shift: any binding matches either shift state", () => {
    const ran: string[] = [];
    const bindings: Binding[] = [{ key: "/", shift: "any", run: () => ran.push("slash") }];
    const plain = press({ key: "/" });
    expect(dispatchKey(plain.event, bindings)).toBe(true);
    const shifted = press({ key: "/", shiftKey: true });
    expect(dispatchKey(shifted.event, bindings)).toBe(true);
    expect(ran).toEqual(["slash", "slash"]);
  });
});

describe("keymap wiring", () => {
  test("'/' opens the palette, shifted or not; Shift+H/I toggle and persist", () => {
    const storage = stubStorage();
    const restoreFetch = stubFetch(() => new Promise(() => {}));
    try {
      const plain = fakeDocument();
      initSearch(plain.doc);
      plain.keydown(press({ key: "/" }).event);
      expect(plain.palette.hidden).toBe(false);
      expect(plain.body.classList.contains("serv-palette-open")).toBe(true);

      // On layouts where "/" needs Shift, event.key is still "/".
      const shifted = fakeDocument();
      initSearch(shifted.doc);
      shifted.keydown(press({ key: "/", shiftKey: true }).event);
      expect(shifted.palette.hidden).toBe(false);

      const toggles = fakeDocument();
      initSearch(toggles.doc);
      toggles.keydown(press({ key: "I", shiftKey: true }).event);
      expect(toggles.html.classList.contains("serv-show-ignored")).toBe(true);
      expect(storage.store.get("serv-show-ignored")).toBe("1");
      toggles.keydown(press({ key: "H", shiftKey: true }).event);
      expect(toggles.html.classList.contains("serv-show-hidden")).toBe(true);
      expect(storage.store.get("serv-show-hidden")).toBe("1");
    } finally {
      restoreFetch();
      storage.restore();
    }
  });

  test("Shift+S flips Preview/Source only on Markdown pages and is skipped in fields", () => {
    const storage = stubStorage();
    try {
      const md = fakeDocument([], { md: "rendered" });
      initSearch(md.doc);

      const first = press({ key: "S", shiftKey: true });
      md.keydown(first.event);
      expect(first.prevented()).toBe(1);
      expect(md.mdLinks.source.getAttribute("clicked")).toBe("1");
      expect(md.mdLinks.rendered.getAttribute("clicked")).toBe(null);

      // From the source panel the key targets Preview.
      md.html.classList.add("serv-md-source");
      md.html.classList.remove("serv-md-rendered");
      md.keydown(press({ key: "S", shiftKey: true }).event);
      expect(md.mdLinks.rendered.getAttribute("clicked")).toBe("1");

      // Editable fields keep the key for typing.
      const inField = press({ key: "S", shiftKey: true, target: { tagName: "INPUT" } });
      md.keydown(inField.event);
      expect(inField.prevented()).toBe(0);
      expect(md.mdLinks.source.getAttribute("clicked")).toBe("1");

      const plain = fakeDocument();
      initSearch(plain.doc);
      const elsewhere = press({ key: "S", shiftKey: true });
      plain.keydown(elsewhere.event);
      expect(elsewhere.prevented()).toBe(0);
    } finally {
      storage.restore();
    }
  });

  test("the live indicator counts each row once and follows the toggle", () => {
    const storage = stubStorage();
    const rows = [
      row("data-hidden"),
      row("data-ignored"),
      row("data-hidden", "data-ignored"),
      row(),
    ];
    try {
      const page = fakeDocument(rows);
      initSearch(page.doc);
      expect(page.button.textContent).toBe("3 hidden");
      expect(page.button.getAttribute("aria-label")).toBe("Show 3 hidden entries");

      page.keydown(press({ key: "H", shiftKey: true }).event);
      // Dotfiles are shown now; the ignored-only and both-tagged rows still count.
      expect(page.button.textContent).toBe("2 hidden");
    } finally {
      storage.restore();
    }
  });
});

describe("palette rows", () => {
  test("build names as text nodes, never HTML", async () => {
    const name = `<img src=x onerror=alert(1)>.md`;
    const restoreFetch = stubFetch(() =>
      Promise.resolve({ ok: true, json: async () => ({ entries: [{ path: name }], truncated: false }) }),
    );
    try {
      const page = fakeDocument();
      initSearch(page.doc);
      page.keydown(press({ key: "/" }).event);
      await new Promise((resolve) => setTimeout(resolve, 0));

      const option = page.list.children.find((child) => hasClass(child, "palette-option"));
      expect(option).toBeDefined();
      const label = option!.children.find((child) => hasClass(child, "palette-path"))!;
      expect(label.textContent).toBe(name);
      expect(label.innerHTML).toBe("");
      expect(option!.innerHTML).toBe("");
    } finally {
      restoreFetch();
    }
  });
});

describe("pre-paint", () => {
  test("restores stored choices with the same polarity", () => {
    const run = (stored: Record<string, string>) => {
      const html = element("html");
      const storage = { getItem: (key: string) => stored[key] ?? null };
      new Function("document", "localStorage", PRE_PAINT)({ documentElement: html }, storage);
      return html;
    };

    const on = run({ "serv-show-hidden": "1", "serv-show-ignored": "0" });
    expect(on.classList.contains("serv-js")).toBe(true);
    expect(on.classList.contains("serv-show-hidden")).toBe(true);
    expect(on.classList.contains("serv-show-ignored")).toBe(false);

    const unset = run({});
    expect(unset.classList.contains("serv-show-hidden")).toBe(false);
    expect(unset.classList.contains("serv-show-ignored")).toBe(false);
  });

  test("restores the saved Markdown panel before paint; an explicit ?view= wins", () => {
    const run = (stored: Record<string, string>, search: string, initial: string) => {
      const html = element("html");
      html.className = initial;
      const storage = { getItem: (key: string) => stored[key] ?? null };
      new Function("document", "localStorage", "location", PRE_PAINT)(
        { documentElement: html },
        storage,
        { search },
      );
      return html;
    };

    const savedSource = run({ "serv-md-view": "source" }, "", "serv-md-page serv-md-rendered");
    expect(savedSource.classList.contains("serv-md-source")).toBe(true);
    expect(savedSource.classList.contains("serv-md-rendered")).toBe(false);

    const savedRendered = run({ "serv-md-view": "rendered" }, "", "serv-md-page serv-md-source");
    expect(savedRendered.classList.contains("serv-md-rendered")).toBe(true);
    expect(savedRendered.classList.contains("serv-md-source")).toBe(false);

    const explicitSource = run({ "serv-md-view": "rendered" }, "?view=source", "serv-md-page serv-md-rendered");
    expect(explicitSource.classList.contains("serv-md-source")).toBe(true);
    expect(explicitSource.classList.contains("serv-md-rendered")).toBe(false);

    const explicitRendered = run({ "serv-md-view": "source" }, "?view=rendered", "serv-md-page serv-md-source");
    expect(explicitRendered.classList.contains("serv-md-rendered")).toBe(true);
    expect(explicitRendered.classList.contains("serv-md-source")).toBe(false);

    // Nothing saved keeps the server's default; other pages are not touched.
    const fresh = run({}, "", "serv-md-page serv-md-rendered");
    expect(fresh.classList.contains("serv-md-rendered")).toBe(true);
    expect(fresh.classList.contains("serv-md-source")).toBe(false);
    const other = run({ "serv-md-view": "source" }, "", "");
    expect(other.classList.contains("serv-md-source")).toBe(false);
    expect(other.classList.contains("serv-js")).toBe(true);
  });
});
