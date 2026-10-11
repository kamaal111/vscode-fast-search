import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchViewHtml } from "../../src/searchView/html.js";
import type { TextMatch } from "../../src/engine/protocol.js";

let dom: JSDOM;
const postMessage = vi.fn();

function element(selector: string): HTMLElement {
  const found = dom.window.document.querySelector(selector);
  if (!(found instanceof dom.window.HTMLElement))
    throw new Error(`Missing element: ${selector}`);
  return found;
}

function sendState(
  count = 1,
  session = 1,
  matchOverrides: Partial<TextMatch> = {},
  history = {
    query: ["beta", "alpha"],
    include: ["src", "docs"],
    exclude: ["dist", "vendor"],
  },
): void {
  const matches = Array.from({ length: count }, (_, line) => ({
    id: `match-${line}`,
    uri: "file:///workspace/src/example.ts",
    line,
    startColumn: 2,
    endLine: line,
    endColumn: 5,
    preview: "a match here",
    previewStart: 2,
    previewEnd: 7,
    ...matchOverrides,
  }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "state",
        state: {
          session,
          query: "match",
          include: "",
          exclude: "",
          searching: false,
          results: matches,
          warnings: [],
          options: {
            caseSensitive: true,
            wholeWord: false,
            regex: false,
          },
        },
        groups:
          count === 0
            ? []
            : [
                {
                  uri: "file:///workspace/src/example.ts",
                  filename: "example.ts",
                  directory: "src",
                  path: "/workspace/src/example.ts",
                  icon: "file-icon-1",
                  count,
                  matches,
                },
              ],
        history,
      },
    }),
  );
}

beforeEach(() => {
  postMessage.mockClear();
  dom = new JSDOM(
    searchViewHtml({
      scriptUri: "search.js",
      styleUri: "search.css",
      cspSource: "vscode-resource:",
      nonce: "test",
    }),
    { runScripts: "outside-only" },
  );
  dom.window.eval(
    "window.acquireVsCodeApi = () => ({ postMessage: window.postMessageSpy });",
  );
  Object.defineProperty(dom.window, "postMessageSpy", { value: postMessage });
  dom.window.eval(readFileSync("media/search.js", "utf8"));
  postMessage.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
});

it("updates the search controls from the extension state", () => {
  sendState();
  expect(element("#query")).toHaveProperty("value", "match");
  expect(element("#include")).toHaveProperty("value", "");
  expect(element("#exclude")).toHaveProperty("value", "");
  expect(
    element("[data-toggle=caseSensitive]").getAttribute("aria-pressed"),
  ).toBe("true");
});

it.each(["    ", "\t\t", " \t "])(
  "removes source indentation %j while preserving highlights and navigation",
  (indent) => {
    sendState(1, 1, {
      preview: `${indent}a match here`,
      previewStart: indent.length + 2,
      previewEnd: indent.length + 7,
      startColumn: indent.length + 2,
      endColumn: indent.length + 7,
    });
    expect(element(".match-preview").textContent).toBe("a match here");
    expect(element(".match-preview mark").textContent).toBe("match");
    element(".result").click();
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "open",
      uri: "file:///workspace/src/example.ts",
      line: 0,
      column: indent.length + 2,
      endLine: 0,
      endColumn: indent.length + 7,
    });
  },
);

it("preserves whitespace that is part of the searched match", () => {
  sendState(1, 1, {
    preview: "    match here",
    previewStart: 2,
    previewEnd: 9,
  });
  expect(element(".match-preview").textContent).toBe("  match here");
  expect(element(".match-preview mark").textContent).toBe("  match");
});

it("names the embedded options and describes every form control", () => {
  expect(
    element(".search-input [data-toggle=caseSensitive]").getAttribute(
      "aria-label",
    ),
  ).toBe("Match Case");
  expect(element("[data-toggle=wholeWord]").getAttribute("aria-label")).toBe(
    "Match Whole Word",
  );
  expect(element("[data-toggle=regex]").getAttribute("aria-label")).toBe(
    "Use Regular Expression",
  );
  for (const control of dom.window.document.querySelectorAll("input, button")) {
    const descriptionId = control.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(
      dom.window.document.getElementById(descriptionId ?? "")?.textContent,
    ).toBeTruthy();
    expect(control.hasAttribute("title")).toBe(false);
  }
});

it("shows delayed hover help and allows entering the tooltip", async () => {
  vi.useFakeTimers();
  const control = element("[data-toggle=wholeWord]");
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseover", { bubbles: true }),
  );
  expect(element("[role=tooltip]").hidden).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  const tooltip = element("[role=tooltip]");
  expect(tooltip.hidden).toBe(false);
  expect(tooltip.textContent).toContain(
    "Match complete words rather than parts of words.",
  );
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: tooltip,
    }),
  );
  expect(tooltip.hidden).toBe(false);
  tooltip.dispatchEvent(
    new dom.window.MouseEvent("mouseout", { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(tooltip.hidden).toBe(true);
  vi.useRealTimers();
});

it("shows keyboard help immediately and dismisses it with Escape and blur", () => {
  element("#cancel").focus();
  expect(element("[role=tooltip]").hidden).toBe(false);
  expect(element("[role=tooltip]").textContent).toContain(
    "Stop the current search.",
  );
  element("#cancel").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
  );
  expect(element("[role=tooltip]").hidden).toBe(true);
  expect(dom.window.document.activeElement).toBe(element("#cancel"));
  element("#query").focus();
  expect(element("[role=tooltip]").hidden).toBe(false);
  element("#query").blur();
  expect(element("[role=tooltip]").hidden).toBe(true);
});

it("preserves input, toggling, submission, and cancellation messages", () => {
  element("#query").dispatchEvent(new dom.window.Event("input"));
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "update",
    field: "query",
    value: "",
  });
  element("[data-toggle=regex]").click();
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "toggle",
    field: "regex",
    value: true,
  });
  expect(element("[data-toggle=regex]").getAttribute("aria-pressed")).toBe(
    "true",
  );
  sendState();
  expect(element("[data-toggle=regex]").getAttribute("aria-pressed")).toBe(
    "false",
  );
  expect(
    element("[data-toggle=caseSensitive]").getAttribute("aria-pressed"),
  ).toBe("true");
  element("#search-form").dispatchEvent(
    new dom.window.Event("submit", { cancelable: true }),
  );
  expect(postMessage).toHaveBeenLastCalledWith({ type: "search" });
  element("#cancel").click();
  expect(postMessage).toHaveBeenLastCalledWith({ type: "cancel" });
});

it("explains result actions and clears help when the results are replaced", () => {
  sendState();
  const row = element(".result");
  expect(row.getAttribute("aria-label")).toContain("line 1, column 3");
  row.focus();
  expect(element("[role=tooltip]").textContent).toContain("Open");
  row.click();
  expect(postMessage).toHaveBeenLastCalledWith({
    type: "open",
    uri: "file:///workspace/src/example.ts",
    line: 0,
    column: 2,
    endLine: 0,
    endColumn: 5,
  });
  sendState(0);
  expect(element("#query")).toBe(dom.window.document.activeElement);
  expect(dom.window.document.querySelector(".result")).toBeNull();
});

it("explains and displays the remaining pagination batch", () => {
  sendState(301);
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(299);
  const more = element(".show-more");
  more.focus();
  expect(element("[role=tooltip]").textContent).toContain(
    "Display the next 2 file and match rows.",
  );
  more.click();
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(301);
  expect(dom.window.document.querySelector(".show-more")).toBeNull();
  expect(dom.window.document.activeElement).toBe(
    dom.window.document.querySelectorAll(".result")[299],
  );
});

it("focuses the first newly revealed match in each pagination batch", () => {
  sendState(1000);
  for (const firstNewMatch of [299, 599, 899]) {
    element(".show-more").focus();
    element(".show-more").click();
    expect(dom.window.document.activeElement).toBe(
      dom.window.document.querySelectorAll(".result")[firstNewMatch],
    );
  }
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(1000);
  expect(dom.window.document.querySelector(".show-more")).toBeNull();
});

it("restores pagination focus when same-session results stream in", () => {
  sendState(1000);
  element(".show-more").focus();
  sendState(1001);
  expect(dom.window.document.activeElement).toBe(element(".show-more"));
});

it("cancels pending hover help and shows it again after reentering", async () => {
  vi.useFakeTimers();
  const control = element("#cancel");
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseover", { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(200);
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseout", { bubbles: true }),
  );
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseover", { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(element("[role=tooltip]").hidden).toBe(false);
  control.dispatchEvent(
    new dom.window.MouseEvent("mouseout", { bubbles: true }),
  );
  await vi.advanceTimersByTimeAsync(300);
  expect(element("[role=tooltip]").hidden).toBe(true);
});

it("clamps a tooltip near the bottom right of the viewport", () => {
  const control = element("#cancel");
  vi.spyOn(control, "getBoundingClientRect").mockReturnValue(
    new dom.window.DOMRect(1000, 740, 24, 26),
  );
  vi.spyOn(element("[role=tooltip]"), "getBoundingClientRect").mockReturnValue(
    new dom.window.DOMRect(0, 0, 320, 80),
  );
  control.focus();
  expect(element("[role=tooltip]").style.left).toBe("700px");
  expect(element("[role=tooltip]").style.top).toBe("656px");
});

it("runs search with Enter from a text field", () => {
  element("#query").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({ type: "search" });
});

it("does not submit while confirming IME composition", () => {
  element("#query").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      isComposing: true,
    }),
  );
  expect(postMessage).not.toHaveBeenCalled();
});

it("renders filename, relative directory, themed icon and the full match count", () => {
  sendState(301);
  expect(element(".filename").textContent).toBe("example.ts");
  expect(element(".directory").textContent).toBe("src");
  expect(element(".match-count").textContent).toBe("301");
  expect(element(".file-icon").classList.contains("file-icon-1")).toBe(true);
  expect(element(".result-heading").title).toBe("/workspace/src/example.ts");
  expect(element("#status").textContent).toBe("301 results in 1 file");
});

it("preserves collapse during batches and resets it for a new search session", () => {
  sendState(2);
  element(".result-heading").click();
  expect(element(".result-group").getAttribute("aria-expanded")).toBe("false");
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(0);
  sendState(3);
  expect(element(".result-group").getAttribute("aria-expanded")).toBe("false");
  expect(element(".match-count").textContent).toBe("3");
  sendState(3, 2);
  expect(element(".result-group").getAttribute("aria-expanded")).toBe("true");
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(3);
});

it("sends session-scoped dismissal without opening or collapsing", () => {
  sendState(2);
  element(".result > .dismiss-result").click();
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "dismissMatch",
    session: 1,
    id: "match-0",
  });
  expect(element(".result-group").getAttribute("aria-expanded")).toBe("true");
  postMessage.mockClear();
  element(".result-heading > .dismiss-result").click();
  expect(postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "dismissFile",
    session: 1,
    uri: "file:///workspace/src/example.ts",
  });
});

it("navigates file and match rows and preserves focused matches across batches", () => {
  sendState(2);
  element(".result-group").focus();
  element(".result-group").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      bubbles: true,
    }),
  );
  expect(dom.window.document.activeElement).toBe(element(".result"));
  sendState(3);
  expect(dom.window.document.activeElement).toBe(element(".result"));
  element(".result").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
    }),
  );
  expect(dom.window.document.activeElement).toBe(element(".result-group"));
  element(".result-group").dispatchEvent(
    new dom.window.KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
    }),
  );
  expect(element(".result-group").getAttribute("aria-expanded")).toBe("false");
});

it("keeps pagination bounded when the result set contains only file headings", () => {
  sendState(1000);
  element(".result-heading").click();
  expect(
    dom.window.document.querySelectorAll('[role="treeitem"]'),
  ).toHaveLength(1);
  expect(dom.window.document.querySelector(".show-more")).toBeNull();
  expect(element(".match-count").textContent).toBe("1000");
});

function input(field: string): HTMLInputElement {
  const found = element(`#${field}`);
  if (!(found instanceof dom.window.HTMLInputElement))
    throw new Error(`Missing input: ${field}`);
  return found;
}

function arrow(
  field: string,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new dom.window.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  input(field).dispatchEvent(event);
  return event;
}

it.each([
  ["query", "beta", "alpha"],
  ["include", "src", "docs"],
  ["exclude", "dist", "vendor"],
])(
  "navigates %s history backwards and forwards to an empty field",
  (field, newest, oldest) => {
    sendState();
    const control = input(field);
    control.focus();
    control.value = "";
    expect(arrow(field, "ArrowUp").defaultPrevented).toBe(true);
    expect(control.value).toBe(newest);
    expect(control.selectionStart).toBe(newest.length);
    expect(postMessage).toHaveBeenLastCalledWith({
      type: "update",
      field,
      value: newest,
    });
    arrow(field, "ArrowUp");
    expect(control.value).toBe(oldest);
    postMessage.mockClear();
    arrow(field, "ArrowUp");
    expect(control.value).toBe(oldest);
    expect(postMessage).not.toHaveBeenCalled();
    arrow(field, "ArrowDown");
    expect(control.value).toBe(newest);
    arrow(field, "ArrowDown");
    expect(control.value).toBe("");
    expect(element("#history-announcement").textContent).toBe("Cleared input");
    expect(dom.window.document.activeElement).toBe(control);
  },
);

it("skips the displayed newest term and keeps its cursor across reordered history messages", () => {
  sendState();
  const control = input("query");
  control.focus();
  control.value = "beta";
  arrow("query", "ArrowUp");
  expect(control.value).toBe("alpha");
  sendState(1, 2, {}, { query: ["alpha", "beta"], include: [], exclude: [] });
  arrow("query", "ArrowDown");
  expect(control.value).toBe("beta");
  arrow("query", "ArrowDown");
  expect(control.value).toBe("");
});

it("resets navigation after editing or leaving a field and keeps field histories independent", () => {
  sendState();
  input("query").focus();
  arrow("query", "ArrowUp");
  input("query").value = "draft";
  input("query").dispatchEvent(new dom.window.Event("input"));
  arrow("query", "ArrowUp");
  expect(input("query").value).toBe("beta");
  input("include").focus();
  arrow("include", "ArrowUp");
  expect(input("include").value).toBe("src");
  input("query").focus();
  arrow("query", "ArrowDown");
  expect(input("query").value).toBe("");
});

it.each([
  { altKey: true },
  { ctrlKey: true },
  { metaKey: true },
  { shiftKey: true },
  { isComposing: true },
])("leaves modified and composing arrow events alone: %j", (options) => {
  sendState();
  input("query").focus();
  expect(arrow("query", "ArrowUp", options).defaultPrevented).toBe(false);
  expect(input("query").value).toBe("match");
  expect(postMessage).not.toHaveBeenCalled();
});

it("leaves empty history unchanged", () => {
  sendState(0, 1, {}, { query: [], include: [], exclude: [] });
  input("query").focus();
  arrow("query", "ArrowUp");
  arrow("query", "ArrowDown");
  expect(input("query").value).toBe("match");
  expect(postMessage).not.toHaveBeenCalled();
});
