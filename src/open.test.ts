import { describe, expect, test } from "bun:test";
import { OPEN_SCRIPT, osascriptArgv, pickBrowser } from "./open";

describe("pickBrowser", () => {
  test("returns null when no Chromium browser is running", () => {
    expect(pickBrowser("  1 ?? S 0:00.01 Finder\n  2 ?? S 0:00.01 Safari")).toBeNull();
  });

  test("picks the first running browser in upstream preference order", () => {
    expect(pickBrowser("Google Chrome Helper\nGoogle Chrome")).toBe("Google Chrome");
    // Canary is also a substring match for Chrome, so order must decide.
    expect(pickBrowser("Google Chrome Canary.app/Contents\nGoogle Chrome")).toBe("Google Chrome Canary");
    expect(pickBrowser("Google Chrome Beta\nGoogle Chrome Dev")).toBe("Google Chrome Dev");
    expect(pickBrowser("Brave Browser\nVivaldi")).toBe("Brave Browser");
    expect(pickBrowser("Microsoft Edge Helper")).toBe("Microsoft Edge");
    expect(pickBrowser("Chromium Helper")).toBe("Chromium");
  });
});

describe("osascriptArgv", () => {
  test("runs the upstream JXA inline and passes url, browser as script arguments", () => {
    const url = "http://127.0.0.1:4412/x";
    const argv = osascriptArgv("Google Chrome", url);
    expect(argv[2]).toBe(OPEN_SCRIPT);
    expect(argv.slice(3)).toEqual(["-l", "JavaScript", url, "Google Chrome"]);
    // The URL travels through argv, never through the script text.
    expect(argv[2]).not.toContain(url);
  });
});
