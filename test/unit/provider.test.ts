import { beforeEach, expect, it, vi } from "vitest";
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
  keys(): readonly string[] {
    return [];
  }
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(_key: string, defaultValue?: T): T | undefined {
    return defaultValue;
  }
  async update(): Promise<void> {}
}

function setup() {
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
    workspaceState: new WorkspaceState(),
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
