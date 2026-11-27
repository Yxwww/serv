/**
 * Open a URL in the browser. On macOS, reuse an existing Chromium tab when
 * possible so rerunning the server does not pile up tabs.
 */

/** Upstream's list and order: the first one running wins. */
export const CHROMIUM_BROWSERS = [
  "Google Chrome Canary",
  "Google Chrome Dev",
  "Google Chrome Beta",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Vivaldi",
  "Chromium",
];

// Copied from vitejs/vite packages/vite/bin/openChrome.js (MIT).
// Copyright (c) 2019-present, VoidZero Inc. and Vite contributors.
// Inline because `bun build --compile` ships a single binary.
export const OPEN_SCRIPT = `/*
Copyright (c) 2015-present, Facebook, Inc.

This source code is licensed under the MIT license found in the
LICENSE file at
https://github.com/react/create-react-app/blob/main/LICENSE
*/

/* global Application */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function run(argv) {
  const urlToOpen = argv[0]
  // Allow requested program to be optional, default to Google Chrome
  const programName = argv[1] ?? 'Google Chrome'

  const app = Application(programName)

  if (app.windows.length === 0) {
    app.Window().make()
  }

  // 1: Looking for tab running debugger then,
  //    Reload debugging tab if found, then return
  const found = lookupTabWithUrl(urlToOpen, app)
  if (found) {
    found.targetWindow.activeTabIndex = found.targetTabIndex
    found.targetTab.reload()
    found.targetWindow.index = 1
    app.activate()
    return
  }

  // 2: Looking for Empty tab
  //    In case debugging tab was not found
  //    We try to find an empty tab instead
  const emptyTabFound = lookupTabWithUrl('chrome://newtab/', app)
  if (emptyTabFound) {
    emptyTabFound.targetWindow.activeTabIndex = emptyTabFound.targetTabIndex
    emptyTabFound.targetTab.url = urlToOpen
    app.activate()
    return
  }

  // 3: Create new tab
  //    both debugging and empty tab were not found make a new tab with url
  const firstWindow = app.windows[0]
  firstWindow.tabs.push(app.Tab({ url: urlToOpen }))
  app.activate()
}

/**
 * Lookup tab with given url
 */
function lookupTabWithUrl(lookupUrl, app) {
  const windows = app.windows()
  for (const window of windows) {
    for (const [tabIndex, tab] of window.tabs().entries()) {
      if (tab.url().includes(lookupUrl)) {
        return {
          targetTab: tab,
          targetTabIndex: tabIndex + 1,
          targetWindow: window,
        }
      }
    }
  }
}
`;

/** The browser to reuse, from `ps cax` output; null when none is running. */
export function pickBrowser(psOutput: string): string | null {
  for (const browser of CHROMIUM_BROWSERS) {
    if (psOutput.includes(browser)) return browser;
  }
  return null;
}

/** Upstream's JXA `run(argv)` takes the URL first and the browser name second. */
export function osascriptArgv(browser: string, url: string): string[] {
  return ["osascript", "-e", OPEN_SCRIPT, "-l", "JavaScript", url, browser];
}

function openerCommand(url: string): string[] {
  return process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url];
}

function spawnOpener(url: string): void {
  try {
    // A missing opener should not stop the server; the printed URL still works.
    Bun.spawn(openerCommand(url), { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // Same: the printed URL is still usable.
  }
}

async function openOnMac(url: string): Promise<void> {
  const ps = Bun.spawn(["ps", "cax"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await new Response(ps.stdout).text();
  const browser = pickBrowser(output);
  if (!browser) {
    spawnOpener(url);
    return;
  }
  const script = Bun.spawn(osascriptArgv(browser, url), { stdio: ["ignore", "ignore", "ignore"] });
  // A denied Automation permission lands here; the plain opener always works.
  if ((await script.exited) !== 0) spawnOpener(url);
}

/** Fire-and-forget: returns immediately and handles every failure internally. */
export function openBrowser(url: string): void {
  if (process.platform !== "darwin") {
    spawnOpener(url);
    return;
  }
  void openOnMac(url).catch(() => spawnOpener(url));
}
