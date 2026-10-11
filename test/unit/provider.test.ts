import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type {
  EngineClient,
  TextSearchCallbacks,
} from "../../src/engine/client.js";
import type { TextMatch } from "../../src/engine/protocol.js";
import { SearchViewProvider } from "../../src/searchView/provider.js";
import { resultId } from "../../src/searchView/model.js";

const host = vi.hoisted(() => {
  class Resource {
    constructor(private readonly value: URL) {}
    get scheme() {
      return this.value.protocol.slice(0, -1);
    }
    get authority() {
      return this.value.host;
    }
    get path() {
      return decodeURIComponent(this.value.pathname);
    }
    get fsPath() {
      return this.path;
    }
    toString() {
      return this.value.href;
    }
    static parse(value: string) {
      return new Resource(new URL(value));
    }
    static joinPath(uri: Resource, ...paths: string[]) {
      const url = new URL(
        paths.join("/"),
        `${uri.toString().replace(/\/$/, "")}/`,
      );
      url.pathname = url.pathname.replace(/\/$/, "") || "/";
      return new Resource(url);
    }
  }
  const event = () => ({ dispose: vi.fn() });
  const roots = [
    { uri: Resource.parse("file:///workspace"), name: "workspace", index: 0 },
  ];
  const configurations: Record<string, unknown> = {
    "search.searchOnType": false,
    "workbench.iconTheme": null,
  };
  return {
    Resource,
    event,
    roots,
    configurations,
    openTextDocument: vi.fn(),
    extensions: { all: [], onDidChange: vi.fn(event) },
  };
});
vi.mock("vscode", () => ({
  Uri: host.Resource,
  workspace: {
    workspaceFolders: host.roots,
    textDocuments: [],
    getWorkspaceFolder: (uri: { path: string }) =>
      host.roots.find(
        (root) =>
          uri.path === root.uri.path ||
          uri.path.startsWith(`${root.uri.path}/`),
      ),
    asRelativePath: (uri: { path: string }, includeRoot: boolean) => {
      const root = host.roots.find((item) =>
        uri.path.startsWith(`${item.uri.path}/`),
      );
      if (root === undefined) return uri.path;
      const path = uri.path
        .slice(root.uri.path.length)
        .replace(/^\//, "")
        .replace(/\/$/, "");
      return includeRoot ? `${root.name}${path ? `/${path}` : ""}` : path;
    },
    getConfiguration: (section: string) => ({
      get: (key: string, fallback: unknown) =>
        host.configurations[`${section}.${key}`] ?? fallback,
    }),
    onDidChangeConfiguration: vi.fn(host.event),
    onDidChangeWorkspaceFolders: vi.fn(host.event),
    onDidOpenTextDocument: vi.fn(host.event),
    onDidCloseTextDocument: vi.fn(host.event),
    openTextDocument: host.openTextDocument,
  },
  window: {
    activeTextEditor: undefined,
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: vi.fn(host.event),
  },
  extensions: host.extensions,
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
}));

class WorkspaceState implements vscode.Memento {
  private readonly values = new Map<string, unknown>();
  constructor() {
    this.get.mockImplementation((key) => this.values.get(key));
  }
  keys(): readonly string[] {
    return [...this.values.keys()];
  }
  get = vi.fn(
    <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
  );
  update = vi.fn(async (key: string, value: unknown): Promise<void> => {
    if (
      !Array.isArray(value) ||
      !value.every((item): item is string => typeof item === "string")
    )
      throw new Error("Expected string history");
    this.values.set(key, value);
  });
  history(key: string): unknown {
    return this.values.get(key);
  }
  seed(key: string, value: unknown): void {
    this.values.set(key, value);
  }
}

function setup(workspaceState: vscode.Memento = new WorkspaceState()) {
  let receive: ((message: unknown) => unknown) | undefined;
  let callbacks: TextSearchCallbacks | undefined;
  const postMessage = vi.fn(async (_message: unknown) => true);
  const view: vscode.WebviewView = {
    viewType: "fastSearch.searchView",
    visible: true,
    onDidDispose: host.event,
    onDidChangeVisibility: host.event,
    show: vi.fn(),
    webview: {
      html: "",
      options: {},
      cspSource: "https://webview.test",
      asWebviewUri: (uri) => uri,
      postMessage,
      onDidReceiveMessage: (listener) => {
        receive = listener;
        return host.event();
      },
    },
  };
  const engine: EngineClient = {
    initialize: async () => undefined,
    reconfigure: async () => undefined,
    fileSearch: async () => [],
    rebuild: async () => undefined,
    shutdown: async () => undefined,
    diagnostics: async () => ({
      ready: true,
      fileCount: 0,
      roots: 1,
      generation: 1,
    }),
    textSearch: (_query, _options, _overlays, next) => {
      callbacks = next;
      return { requestId: "1", cancel: vi.fn() };
    },
  };
  const provider = new SearchViewProvider({
    extensionUri: vscode.Uri.parse("file:///extension"),
    engine,
    workspaceState,
  });
  provider.resolveWebviewView(view);
  const send = (message: unknown): void => {
    if (receive === undefined) throw new Error("Missing message listener");
    receive(message);
  };
  const batch = (matches: TextMatch[]): void => {
    if (callbacks === undefined) throw new Error("Missing search callbacks");
    callbacks.onBatch(matches);
  };
  send({ type: "update", field: "query", value: "match" });
  send({ type: "search" });
  return { provider, view, send, batch, postMessage };
}
function match(uri: string): TextMatch {
  return {
    uri,
    rootId: "workspace",
    line: 0,
    startColumn: 1,
    endLine: 0,
    endColumn: 6,
    preview: "a match",
    previewStart: 2,
    previewEnd: 7,
  };
}
beforeEach(() => {
  host.roots.splice(0, host.roots.length, {
    uri: host.Resource.parse("file:///workspace"),
    name: "workspace",
    index: 0,
  });
  host.openTextDocument.mockClear();
  host.configurations["search.searchOnType"] = false;
});

it("decodes filename and relative directory while retaining the full tooltip path", () => {
  const { provider, batch, postMessage } = setup();
  batch([match("file:///workspace/src/my%20file.ts")]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: [
        expect.objectContaining({
          filename: "my file.ts",
          directory: "src",
          path: "/workspace/src/my file.ts",
          count: 1,
        }),
      ],
    }),
  );
  provider.dispose();
});

it("omits the directory for root files and labels untitled and outside-workspace results", () => {
  const { provider, batch, postMessage } = setup();
  batch([
    match("file:///workspace/pnpm-workspace.yaml"),
    match("file:///elsewhere/example.ts"),
    match("untitled:Untitled-1"),
  ]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          filename: "pnpm-workspace.yaml",
          directory: "",
          path: "/workspace/pnpm-workspace.yaml",
        }),
        expect.objectContaining({
          filename: "example.ts",
          directory: "/elsewhere",
        }),
        expect.objectContaining({
          filename: "Untitled-1",
          directory: "Unsaved",
        }),
      ]),
    }),
  );
  provider.dispose();
});

it("qualifies directories with root names in a multi-root workspace", () => {
  host.roots.push({
    uri: host.Resource.parse("file:///other"),
    name: "other",
    index: 1,
  });
  const { provider, batch, postMessage } = setup();
  batch([
    match("file:///workspace/src/example.ts"),
    match("file:///other/src/example.ts"),
  ]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          filename: "example.ts",
          directory: "workspace/src",
        }),
        expect.objectContaining({
          filename: "example.ts",
          directory: "other/src",
        }),
      ]),
    }),
  );
  provider.dispose();
});

it("omits directories for root files in every workspace folder", () => {
  host.roots.push({
    uri: host.Resource.parse("file:///other"),
    name: "other",
    index: 1,
  });
  const { provider, batch, postMessage } = setup();
  batch([
    match("file:///workspace/package.json"),
    match("file:///other/package.json"),
  ]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: expect.arrayContaining([
        expect.objectContaining({
          filename: "package.json",
          directory: "",
          path: "/workspace/package.json",
        }),
        expect.objectContaining({
          filename: "package.json",
          directory: "",
          path: "/other/package.json",
        }),
      ]),
    }),
  );
  provider.dispose();
});

it("validates dismissal messages and removes the final file without opening it", () => {
  const { provider, batch, send, postMessage } = setup();
  const result = match("file:///workspace/src/example.ts");
  batch([result]);
  postMessage.mockClear();
  send({ type: "dismissMatch", session: "1", id: resultId(result) });
  send({ type: "dismissFile", session: -1, uri: result.uri });
  send({ type: "dismissMatch", session: 0, id: resultId(result) });
  expect(postMessage).not.toHaveBeenCalled();
  send({ type: "dismissMatch", session: 1, id: resultId(result) });
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      groups: [],
      state: expect.objectContaining({ results: [] }),
    }),
  );
  expect(host.openTextDocument).not.toHaveBeenCalled();
  provider.dispose();
});

it("resends the current state and theme after the webview announces readiness", () => {
  const { provider, send, postMessage, view } = setup();
  postMessage.mockClear();
  send({ type: "ready" });
  expect(postMessage).toHaveBeenNthCalledWith(1, {
    type: "iconTheme",
    css: "",
  });
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({ type: "state" }),
  );
  expect(view.webview.html).toContain(
    "img-src https://webview.test; font-src https://webview.test",
  );
  provider.dispose();
});

it("records independent histories on Enter, retaining exact text and omitting empty filters", async () => {
  const storage = new WorkspaceState();
  const { provider, send, postMessage } = setup(storage);
  send({ type: "update", field: "query", value: " alpha " });
  send({ type: "update", field: "include", value: "src, docs" });
  send({ type: "update", field: "exclude", value: "dist" });
  send({ type: "search" });
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.excludeHistory")).toEqual(["dist"]),
  );
  expect(storage.history("fastSearch.history")).toEqual([" alpha ", "match"]);
  expect(storage.history("fastSearch.includeHistory")).toEqual(["src, docs"]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: {
        query: [" alpha ", "match"],
        include: ["src, docs"],
        exclude: ["dist"],
      },
    }),
  );
  provider.dispose();
});

it("records debounced searches without requiring Enter or results", async () => {
  vi.useFakeTimers();
  host.configurations["search.searchOnType"] = true;
  const storage = new WorkspaceState();
  const { provider, send, postMessage } = setup(storage);
  send({ type: "update", field: "query", value: "alpha" });
  send({ type: "update", field: "include", value: "src" });
  await vi.advanceTimersByTimeAsync(300);
  expect(storage.history("fastSearch.history")).toEqual(["alpha", "match"]);
  expect(storage.history("fastSearch.includeHistory")).toEqual(["src"]);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      state: expect.objectContaining({ results: [] }),
      history: expect.objectContaining({ query: ["alpha", "match"] }),
    }),
  );
  provider.dispose();
  vi.useRealTimers();
});

it("deduplicates, caps histories at twenty, and skips unchanged writes and empty queries", async () => {
  const storage = new WorkspaceState();
  const { provider, send } = setup(storage);
  for (let index = 0; index < 21; index += 1) {
    send({ type: "update", field: "query", value: `term-${index}` });
    send({ type: "search" });
  }
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.history")).toEqual(
      Array.from({ length: 20 }, (_, index) => `term-${20 - index}`),
    ),
  );
  expect(storage.history("fastSearch.history")).toHaveLength(20);
  expect(storage.history("fastSearch.history")).not.toContain("match");
  send({ type: "update", field: "query", value: "term-2" });
  send({ type: "search" });
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.history")).toEqual([
      "term-2",
      ...Array.from({ length: 20 }, (_, index) => `term-${20 - index}`).filter(
        (item) => item !== "term-2",
      ),
    ]),
  );
  const writes = storage.update.mock.calls.length;
  send({ type: "search" });
  send({ type: "update", field: "query", value: "" });
  send({ type: "update", field: "include", value: "ignored" });
  send({ type: "search" });
  await Promise.resolve();
  expect(storage.update).toHaveBeenCalledTimes(writes);
  provider.dispose();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("restores legacy and filter history when recreating a provider and isolates another workspace", async () => {
  const storage = new WorkspaceState();
  storage.seed("fastSearch.history", ["legacy"]);
  const first = setup(storage);
  first.send({ type: "update", field: "include", value: "src" });
  first.send({ type: "update", field: "exclude", value: "dist" });
  first.send({ type: "search" });
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.excludeHistory")).toEqual(["dist"]),
  );
  first.provider.dispose();
  const restored = setup(storage);
  expect(restored.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: {
        query: ["match", "legacy"],
        include: ["src"],
        exclude: ["dist"],
      },
    }),
  );
  restored.provider.dispose();
  const isolated = setup();
  expect(isolated.postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: { query: ["match"], include: [], exclude: [] },
    }),
  );
  isolated.provider.dispose();
});

it("ignores malformed persisted histories and filters invalid or duplicate entries", () => {
  const storage = new WorkspaceState();
  storage.seed("fastSearch.history", ["legacy", 4, "", "legacy", "older"]);
  storage.seed("fastSearch.includeHistory", { invalid: true });
  storage.seed("fastSearch.excludeHistory", [null, "dist", false]);
  const { provider, postMessage } = setup(storage);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: {
        query: ["match", "legacy", "older"],
        include: [],
        exclude: ["dist"],
      },
    }),
  );
  provider.dispose();
});

it("keeps in-memory history and continues saving after a persistence failure", async () => {
  const storage = new WorkspaceState();
  storage.update.mockRejectedValueOnce(new Error("disk unavailable"));
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { provider, send, postMessage } = setup(storage);
  send({ type: "update", field: "query", value: "alpha" });
  send({ type: "search" });
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.history")).toEqual(["alpha", "match"]),
  );
  expect(report).toHaveBeenCalledExactlyOnceWith(
    "Fast Search: failed to persist search history",
    expect.any(Error),
  );
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      history: expect.objectContaining({ query: ["alpha", "match"] }),
    }),
  );
  provider.dispose();
});

it("serializes history writes even when a previous write is still pending", async () => {
  const storage = new WorkspaceState();
  const pending = Promise.withResolvers<void>();
  storage.update.mockImplementationOnce(() => pending.promise);
  const { provider, send } = setup(storage);
  send({ type: "update", field: "query", value: "alpha" });
  send({ type: "search" });
  await Promise.resolve();
  expect(storage.update).toHaveBeenCalledTimes(1);
  pending.resolve();
  await vi.waitFor(() =>
    expect(storage.history("fastSearch.history")).toEqual(["alpha", "match"]),
  );
  expect(storage.update).toHaveBeenCalledTimes(2);
  provider.dispose();
});
