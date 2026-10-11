import { test as base, expect, type Page } from "@playwright/test";
import type { TextMatch } from "../../src/engine/protocol.js";
import type { SearchState } from "../../src/searchView/model.js";

export type UiOptions = { theme: "dark" | "light" | "high-contrast" };
type UiFixtures = { messages: unknown[]; browserErrors: string[] };
declare global {
  interface Window {
    postMessageToHost(message: unknown): Promise<void>;
  }
}

export const test = base.extend<UiFixtures & UiOptions>({
  theme: ["dark", { option: true }],
  messages: async ({}, use) => {
    await use([]);
  },
  browserErrors: async ({}, use) => {
    await use([]);
  },
  page: async ({ page, theme, messages, browserErrors }, use) => {
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.exposeFunction("postMessageToHost", (message: unknown) => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      )
        return;
      messages.push(message);
    });
    await page.addInitScript(() => {
      Object.defineProperty(window, "acquireVsCodeApi", {
        value: () => ({
          postMessage: (message: unknown) => {
            void window.postMessageToHost(message);
          },
        }),
      });
    });
    await page.goto(`/?theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await use(page);
  },
});
test.afterEach(async ({ browserErrors }) => {
  expect(browserErrors).toEqual([]);
});
export { expect };

type RenderOptions = {
  count?: number;
  searching?: boolean;
  error?: string;
  session?: number;
  firstLine?: number;
  indent?: string;
};
export async function renderState(
  page: Page,
  {
    count = 2,
    searching = false,
    error,
    session = 1,
    firstLine = 1,
    indent = "",
  }: RenderOptions = {},
): Promise<void> {
  const uri = "file:///workspace/src/Result.swift";
  const matches: TextMatch[] = Array.from({ length: count }, (_, line) => ({
    uri,
    rootId: "workspace",
    line: line + firstLine,
    startColumn: indent.length + 13,
    endLine: line + firstLine,
    endColumn: indent.length + 31,
    preview: `${indent}let value = "searchable fixture"`,
    previewStart: indent.length + 13,
    previewEnd: indent.length + 31,
  }));
  const state: SearchState = {
    session,
    query: "searchable fixture",
    include: "",
    exclude: "",
    searching,
    error,
    results: matches,
    warnings: [],
    options: {
      caseSensitive: false,
      wholeWord: false,
      regex: false,
      smartCase: true,
      multiline: false,
    },
  };
  await page.evaluate(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "iconTheme",
          css: ".file-icon-0::before {content: 'S';color: #e76e3c;font-family: sans-serif;font-size: 14px;}",
        },
      }),
    ),
  );
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    {
      type: "state",
      state,
      groups:
        matches.length === 0
          ? []
          : [
              {
                uri,
                filename: "Result.swift",
                directory: "src",
                path: "/workspace/src/Result.swift",
                icon: "file-icon-0",
                count: matches.length,
                matches: matches.map((match) => ({
                  ...match,
                  id: JSON.stringify([
                    match.uri,
                    match.line,
                    match.startColumn,
                    match.endLine,
                    match.endColumn,
                  ]),
                })),
              },
            ],
      history: [],
    },
  );
}
