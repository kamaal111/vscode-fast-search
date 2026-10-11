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
    await page.exposeFunction("postMessageToHost", (message: unknown) =>
      messages.push(message),
    );
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

type RenderOptions = { count?: number; searching?: boolean; error?: string };
export async function renderState(
  page: Page,
  { count = 2, searching = false, error }: RenderOptions = {},
): Promise<void> {
  const uri = "file:///workspace/src/Result.swift";
  const matches: TextMatch[] = Array.from({ length: count }, (_, line) => ({
    uri,
    rootId: "workspace",
    line: line + 1,
    startColumn: 13,
    endLine: line + 1,
    endColumn: 31,
    preview: 'let value = "searchable fixture"',
    previewStart: 13,
    previewEnd: 31,
  }));
  const state: SearchState = {
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
      useExcludes: true,
    },
  };
  await page.evaluate(
    (data) => window.dispatchEvent(new MessageEvent("message", { data })),
    {
      type: "state",
      state,
      groups: matches.length === 0 ? [] : [{ uri, matches }],
      history: [],
    },
  );
}
