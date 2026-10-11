import { beforeEach, expect, it, vi } from "vitest";
import { resolveConfiguration } from "../../src/configuration/configuration.js";

const settings = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [
      { uri: { scheme: "file", fsPath: "/one", toString: () => "one" } },
      { uri: { scheme: "file", fsPath: "/two", toString: () => "two" } },
    ],
    getConfiguration: (section: string, uri?: { toString(): string }) => ({
      get: (key: string, fallback: unknown) =>
        settings.get(`${uri?.toString() ?? "global"}:${section}`)?.[key] ??
        fallback,
    }),
  },
}));

beforeEach(() => settings.clear());

it("defaults to local ignores without global or parent ignores", () => {
  const { search } = resolveConfiguration();
  expect(search.rootExcludes).toEqual({ one: [], two: [] });
  expect(search.useIgnoreFilesByRoot).toEqual({ one: true, two: true });
  expect(search.useGlobalIgnoreFilesByRoot).toEqual({ one: false, two: false });
  expect(search.useParentIgnoreFilesByRoot).toEqual({ one: false, two: false });
});

it("merges search exclusions over file exclusions before removing disabled patterns", () => {
  settings.set("one:files", {
    exclude: { "**/generated": true, "**/cache": true },
  });
  settings.set("one:search", {
    exclude: { "**/generated": false, "**/vendor": true },
  });
  expect(resolveConfiguration().search.rootExcludes).toEqual({
    one: ["**/cache", "**/vendor"],
    two: [],
  });
});

it("preserves valid sibling conditions and rejects malformed exclusion values", () => {
  settings.set("one:files", {
    exclude: {
      "**/*.js": { when: "$(basename).ts" },
      "**/disabled": false,
      "**/invalid": { when: 42 },
      "**/text": "true",
    },
  });
  expect(resolveConfiguration().search.rootExcludes.one).toEqual([
    { pattern: "**/*.js", when: "$(basename).ts" },
  ]);
});

it("resolves each workspace folder's ignore settings independently", () => {
  settings.set("one:search", {
    useIgnoreFiles: false,
    useGlobalIgnoreFiles: true,
  });
  settings.set("two:search", { useParentIgnoreFiles: true });
  const { search } = resolveConfiguration();
  expect(search.useIgnoreFilesByRoot).toEqual({ one: false, two: true });
  expect(search.useGlobalIgnoreFilesByRoot).toEqual({ one: true, two: false });
  expect(search.useParentIgnoreFilesByRoot).toEqual({ one: false, two: true });
});
