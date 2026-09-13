import * as vscode from "vscode";
import type { EngineClient } from "../engine/client.js";
import type { DocumentOverlay, TextMatch } from "../engine/protocol.js";
import { SearchModel, type SearchState } from "./model.js";

type ProviderOptions = {
  extensionUri: vscode.Uri;
  engine: EngineClient;
  workspaceState: vscode.Memento;
};
type WebviewMessage =
  | { type: "update"; field: "query" | "include" | "exclude"; value: string }
  | {
      type: "toggle";
      field: "regex" | "caseSensitive" | "wholeWord" | "useExcludes";
      value: boolean;
    }
  | { type: "search" }
  | { type: "cancel" }
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
  constructor(private readonly options: ProviderOptions) {
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
  }
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const webview = view.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.options.extensionUri, "media"),
      ],
    };
    webview.html = this.html(webview);
    webview.onDidReceiveMessage((raw: unknown) => {
      const message = decodeWebviewMessage(raw);
      if (message !== undefined) void this.handle(message);
    });
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
  }

  private async handle(message: WebviewMessage): Promise<void> {
    if (message.type === "update")
      this.model.update({ [message.field]: message.value });
    else if (message.type === "toggle")
      this.model.update({ options: { [message.field]: message.value } });
    else if (message.type === "search") {
      this.remember(this.model.current().query);
      this.model.search();
    } else if (message.type === "cancel") this.model.cancel();
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
      groups: groupResults(state.results),
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
    return `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${style}"></head><body><form id="search-form"><label>Search<input id="query" list="history" autocomplete="off"><datalist id="history"></datalist></label><div class="toggles"><button type="button" data-toggle="caseSensitive" aria-pressed="false" title="Match Case">Aa</button><button type="button" data-toggle="wholeWord" aria-pressed="false" title="Whole Word">ab</button><button type="button" data-toggle="regex" aria-pressed="false" title="Regular Expression">.*</button><button type="button" id="cancel">Cancel</button></div><label>Files to include<input id="include"></label><label>Files to exclude<input id="exclude"></label><label class="check"><input id="useExcludes" type="checkbox" checked> Use exclude and ignore settings</label></form><div id="status" role="status" aria-live="polite"></div><div id="results" role="tree" aria-label="Search results"></div><script nonce="${nonce}" src="${script}"></script></body></html>`;
  }
}

function groupResults(
  results: TextMatch[],
): { uri: string; matches: TextMatch[] }[] {
  const groups = new Map<string, TextMatch[]>();
  for (const result of results)
    groups.set(result.uri, [...(groups.get(result.uri) ?? []), result]);
  return [...groups].map(([uri, matches]) => ({ uri, matches }));
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
  if (value.type === "search" || value.type === "cancel")
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
      value.field === "wholeWord" ||
      value.field === "useExcludes") &&
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
