import * as vscode from "vscode";
import type { EngineClient } from "../engine/client.js";
import type { DocumentOverlay, TextMatch } from "../engine/protocol.js";
import { SearchModel, resultId, type SearchState } from "./model.js";
import { searchViewHtml } from "./html.js";
import { IconTheme } from "./iconTheme.js";

type ProviderOptions = {
  extensionUri: vscode.Uri;
  engine: EngineClient;
  workspaceState: vscode.Memento;
};
type WebviewMessage =
  | { type: "update"; field: "query" | "include" | "exclude"; value: string }
  | {
      type: "toggle";
      field: "regex" | "caseSensitive" | "wholeWord";
      value: boolean;
    }
  | { type: "ready" }
  | { type: "search" }
  | { type: "cancel" }
  | { type: "dismissMatch"; session: number; id: string }
  | { type: "dismissFile"; session: number; uri: string }
  | {
      type: "open";
      uri: string;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
    };

export class SearchViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private indexStatus: string | undefined;
  private readonly model: SearchModel;
  private readonly icons: IconTheme;
  private readonly subscriptions: vscode.Disposable[] = [];
  private lastIconCss: string | undefined;
  constructor(private readonly options: ProviderOptions) {
    this.icons = new IconTheme({
      webview: () => this.view?.webview,
      changed: () => this.refreshTheme(),
    });
    this.model = new SearchModel({
      engine: options.engine,
      debounceMs: () =>
        vscode.workspace
          .getConfiguration("search")
          .get("searchOnTypeDebouncePeriod", 300),
      searchOnType: () =>
        vscode.workspace.getConfiguration("search").get("searchOnType", true),
      overlays: () => this.overlays(),
      encoding: () => {
        const resource =
          vscode.window.activeTextEditor?.document.uri ??
          vscode.workspace.workspaceFolders?.[0]?.uri;
        return vscode.workspace
          .getConfiguration("files", resource)
          .get<string>("encoding");
      },
      onChange: (state) => this.renderState(state),
    });
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("search.showLineNumbers"))
          this.renderState(this.model.current());
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.renderState(this.model.current()),
      ),
    );
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastIconCss = undefined;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, "media"),
      ],
    };
    webview.html = this.html(webview);
    this.subscriptions.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = decodeWebviewMessage(raw);
        if (message !== undefined) void this.handle(message);
      }),
    );
    this.subscriptions.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.refreshTheme(true);
      }),
    );
    this.subscriptions.push(
      view.onDidDispose(() => {
        if (this.view === view) this.view = undefined;
      }),
    );
    void this.icons.reload();
    this.seedFromEditor();
    this.renderState(this.model.current());
  }
  show(): void {
    this.view?.show(true);
  }
  setIndexProgress(rootId: string, filesIndexed: number): void {
    this.indexStatus = `Indexing ${rootId}… ${filesIndexed} files`;
    this.renderState(this.model.current());
  }
  setIndexReady(fileCount: number): void {
    this.indexStatus = undefined;
    this.renderState(this.model.current(), `${fileCount} files indexed`);
  }
  dispose(): void {
    this.model.dispose();
    this.icons.dispose();
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (message.type === "ready") this.refreshTheme(true);
    else if (message.type === "update")
      this.model.update({ [message.field]: message.value });
    else if (message.type === "toggle")
      this.model.update({ options: { [message.field]: message.value } });
    else if (message.type === "search") {
      this.remember(this.model.current().query);
      this.model.search();
    } else if (message.type === "cancel") this.model.cancel();
    else if (message.type === "dismissMatch")
      this.model.dismissMatch(message.session, message.id);
    else if (message.type === "dismissFile")
      this.model.dismissFile(message.session, message.uri);
    else {
      const position = new vscode.Position(message.line, message.column);
      const end = new vscode.Position(message.endLine, message.endColumn);
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(message.uri),
      );
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(position, end);
      editor.revealRange(new vscode.Range(position, end));
    }
  }
  private refreshTheme(force = false): void {
    const webview = this.view?.webview;
    if (webview === undefined) return;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, "media"),
        ...this.icons.roots,
      ],
    };
    if (force || this.lastIconCss !== this.icons.css) {
      this.lastIconCss = this.icons.css;
      void webview.postMessage({ type: "iconTheme", css: this.icons.css });
    }
    this.renderState(this.model.current());
  }
  private seedFromEditor(): void {
    const editor = vscode.window.activeTextEditor;
    const seedSetting = vscode.workspace
      .getConfiguration("editor", editor?.document.uri)
      .get<string | boolean>("find.seedSearchStringFromSelection", "always");
    if (seedSetting === false || seedSetting === "never") return;
    if (editor === undefined || editor.selection.isEmpty) return;
    const seed = editor.document.getText(editor.selection);
    if (!seed.includes("\n")) this.model.update({ query: seed });
  }
  private overlays(): DocumentOverlay[] {
    return vscode.workspace.textDocuments
      .filter((document) => document.isDirty || document.isUntitled)
      .map((document) => ({
        uri: document.uri.toString(),
        text: document.getText(),
        untitled: document.isUntitled,
      }));
  }
  private remember(query: string): void {
    if (query.length === 0) return;
    const prior = this.options.workspaceState.get<string[]>(
      "fastSearch.history",
      [],
    );
    void this.options.workspaceState.update(
      "fastSearch.history",
      [query, ...prior.filter((item) => item !== query)].slice(0, 20),
    );
  }
  private renderState(state: SearchState, announcement?: string): void {
    void this.view?.webview.postMessage({
      type: "state",
      state,
      groups: groupResults(state.results, this.icons),
      showLineNumbers: vscode.workspace
        .getConfiguration("search")
        .get("showLineNumbers", false),
      history: this.options.workspaceState.get<string[]>(
        "fastSearch.history",
        [],
      ),
      indexStatus: this.indexStatus,
      announcement,
    });
  }
  private html(webview: vscode.Webview): string {
    const nonce = nonceValue();
    const script = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "media", "search.js"),
    );
    const style = webview.asWebviewUri(
      vscode.Uri.joinPath(this.options.extensionUri, "media", "search.css"),
    );
    return searchViewHtml({
      scriptUri: script.toString(),
      styleUri: style.toString(),
      cspSource: webview.cspSource,
      nonce,
    });
  }
}

function groupResults(results: TextMatch[], icons: IconTheme) {
  const groups = new Map<string, TextMatch[]>();
  for (const result of results) {
    const matches = groups.get(result.uri);
    if (matches === undefined) groups.set(result.uri, [result]);
    else matches.push(result);
  }
  const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
  return [...groups].map(([uri, matches]) => {
    const resource = vscode.Uri.parse(uri);
    const filename = resource.path.split("/").at(-1) || resource.toString();
    const folder = vscode.workspace.getWorkspaceFolder(resource);
    const parent =
      resource.scheme === "untitled"
        ? resource
        : vscode.Uri.joinPath(resource, "..");
    const directory =
      folder === undefined
        ? resource.scheme === "untitled"
          ? "Unsaved"
          : parent.fsPath
        : parent.toString() === folder.uri.toString()
          ? ""
          : vscode.workspace.asRelativePath(parent, multiRoot);
    return {
      uri,
      filename,
      directory: directory === "." ? "" : directory,
      path: resource.scheme === "file" ? resource.fsPath : resource.toString(),
      icon: icons.icon(resource),
      count: matches.length,
      matches: matches.map((match) => ({ ...match, id: resultId(match) })),
    };
  });
}
function nonceValue(): string {
  const alphabet =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from(
    { length: 32 },
    () => alphabet[Math.floor(Math.random() * alphabet.length)] ?? "x",
  ).join("");
}
function decodeWebviewMessage(value: unknown): WebviewMessage | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("type" in value) ||
    typeof value.type !== "string"
  )
    return undefined;
  if (
    (value.type === "dismissMatch" || value.type === "dismissFile") &&
    "session" in value &&
    typeof value.session === "number" &&
    Number.isSafeInteger(value.session) &&
    value.session >= 0
  ) {
    if (
      value.type === "dismissMatch" &&
      "id" in value &&
      typeof value.id === "string"
    )
      return { type: value.type, session: value.session, id: value.id };
    if (
      value.type === "dismissFile" &&
      "uri" in value &&
      typeof value.uri === "string"
    )
      return { type: value.type, session: value.session, uri: value.uri };
    return undefined;
  }
  if (
    value.type === "ready" ||
    value.type === "search" ||
    value.type === "cancel"
  )
    return { type: value.type };
  if (
    value.type === "update" &&
    "field" in value &&
    (value.field === "query" ||
      value.field === "include" ||
      value.field === "exclude") &&
    "value" in value &&
    typeof value.value === "string"
  )
    return { type: value.type, field: value.field, value: value.value };
  if (
    value.type === "toggle" &&
    "field" in value &&
    (value.field === "regex" ||
      value.field === "caseSensitive" ||
      value.field === "wholeWord") &&
    "value" in value &&
    typeof value.value === "boolean"
  )
    return { type: value.type, field: value.field, value: value.value };
  if (
    value.type === "open" &&
    "uri" in value &&
    typeof value.uri === "string" &&
    "line" in value &&
    typeof value.line === "number" &&
    Number.isInteger(value.line) &&
    value.line >= 0 &&
    "column" in value &&
    typeof value.column === "number" &&
    Number.isInteger(value.column) &&
    value.column >= 0 &&
    "endLine" in value &&
    typeof value.endLine === "number" &&
    Number.isInteger(value.endLine) &&
    value.endLine >= value.line &&
    "endColumn" in value &&
    typeof value.endColumn === "number" &&
    Number.isInteger(value.endColumn) &&
    value.endColumn >= 0
  )
    return {
      type: value.type,
      uri: value.uri,
      line: value.line,
      column: value.column,
      endLine: value.endLine,
      endColumn: value.endColumn,
    };
  return undefined;
}
