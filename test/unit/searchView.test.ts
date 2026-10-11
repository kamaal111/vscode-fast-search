import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { searchViewHtml } from "../../src/searchView/html.js";

let dom: JSDOM;
const postMessage = vi.fn();

function element(selector: string): HTMLElement {
  const found = dom.window.document.querySelector(selector);
  if (!(found instanceof dom.window.HTMLElement))
    throw new Error(`Missing element: ${selector}`);
  return found;
}

function sendState(count = 1): void {
  const matches = Array.from({ length: count }, (_, line) => ({
    uri: "file:///workspace/src/example.ts",
    line,
    startColumn: 2,
    endLine: line,
    endColumn: 5,
    preview: "a match here",
    previewStart: 2,
    previewEnd: 7,
  }));
  dom.window.dispatchEvent(
    new dom.window.MessageEvent("message", {
      data: {
        type: "state",
        state: {
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
            useExcludes: true,
          },
        },
        groups: [{ uri: "file:///workspace/src/example.ts", matches }],
        history: [],
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
});
afterEach(() => {
  vi.useRealTimers();
  dom.window.close();
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
  expect(element("[role=tooltip]").hidden).toBe(true);
  expect(dom.window.document.querySelector(".result")).toBeNull();
});

it("explains and displays the remaining pagination batch", () => {
  sendState(301);
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(300);
  const more = element(".show-more");
  more.focus();
  expect(element("[role=tooltip]").textContent).toContain(
    "Display the next 1 search results.",
  );
  more.click();
  expect(dom.window.document.querySelectorAll(".result")).toHaveLength(301);
  expect(dom.window.document.querySelector(".show-more")).toBeNull();
  expect(element("[role=tooltip]").hidden).toBe(true);
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
