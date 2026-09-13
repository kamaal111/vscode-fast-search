import * as path from "node:path";
import * as vscode from "vscode";
import type { EngineClient } from "../engine/client.js";
import type { FileMatch } from "../engine/protocol.js";

type PickerOptions = {
  engine: EngineClient;
  maxResults(): number;
  preserveInput(): boolean;
};
type MatchItem = vscode.QuickPickItem & { match: FileMatch };
const openBesideButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("split-horizontal"),
  tooltip: "Open to the Side",
};

export class FilePicker {
  private previousInput = "";
  private readonly recent = new Map<string, { at: number; match: FileMatch }>();
  constructor(private readonly options: PickerOptions) {}

  async show(): Promise<void> {
    const picker = vscode.window.createQuickPick<MatchItem>();
    picker.placeholder = "Search files (append :line[:column] to jump)";
    picker.matchOnDescription = false;
    picker.matchOnDetail = false;
    if (this.options.preserveInput()) picker.value = this.previousInput;
    let generation = 0;
    const update = async (): Promise<void> => {
      const ownGeneration = ++generation;
      picker.busy = true;
      try {
        const editor = vscode.window.activeTextEditor;
        const activeEditor =
          editor?.document.uri.scheme === "file"
            ? {
                uri: editor.document.uri.toString(),
                directory: path.dirname(editor.document.uri.fsPath),
              }
            : undefined;
        const results =
          picker.value.length === 0
            ? this.emptyQueryResults()
            : await this.options.engine.fileSearch(
                picker.value,
                this.options.maxResults(),
                activeEditor,
              );
        if (generation !== ownGeneration) return;
        results.sort(
          (left, right) =>
            (this.recent.get(right.uri)?.at ?? 0) -
              (this.recent.get(left.uri)?.at ?? 0) || right.score - left.score,
        );
        const duplicateNames = new Map<string, number>();
        for (const result of results)
          duplicateNames.set(
            path.basename(result.relativePath),
            (duplicateNames.get(path.basename(result.relativePath)) ?? 0) + 1,
          );
        picker.items = results.map((match) => ({
          label: path.basename(match.relativePath),
          description:
            duplicateNames.get(path.basename(match.relativePath)) === 1
              ? path.dirname(match.relativePath)
              : `${match.rootId} · ${path.dirname(match.relativePath)}`,
          buttons: [openBesideButton],
          match,
        }));
      } catch (error) {
        picker.items = [];
        picker.title = error instanceof Error ? error.message : String(error);
      } finally {
        if (generation === ownGeneration) picker.busy = false;
      }
    };
    picker.onDidChangeValue(() => {
      void update();
    });
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0];
      if (item !== undefined) {
        this.previousInput = picker.value;
        picker.hide();
        void this.open(item.match, false, false);
      }
    });
    picker.onDidChangeActive((items) => {
      const item = items[0];
      if (item !== undefined) void this.open(item.match, true, false, true);
    });
    picker.onDidTriggerItemButton((event) => {
      picker.hide();
      void this.open(event.item.match, false, true, false);
    });
    picker.onDidHide(() => picker.dispose());
    picker.show();
    await update();
  }

  private async open(
    match: FileMatch,
    preview: boolean,
    beside: boolean,
    preserveFocus = false,
  ): Promise<void> {
    const uri = vscode.Uri.parse(match.uri);
    const line = Math.max(0, (match.line ?? 1) - 1);
    const column = Math.max(0, (match.column ?? 1) - 1);
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, {
      preview,
      preserveFocus,
      selection: new vscode.Range(line, column, line, column),
      ...(beside ? { viewColumn: vscode.ViewColumn.Beside } : {}),
    });
    editor.revealRange(
      new vscode.Range(line, column, line, column),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    );
    if (!preview) this.recent.set(match.uri, { at: Date.now(), match });
  }

  private emptyQueryResults(): FileMatch[] {
    const byUri = new Map(
      [...this.recent.values()].map(({ match }) => [match.uri, match]),
    );
    for (const document of vscode.workspace.textDocuments) {
      if (document.uri.scheme !== "file") continue;
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);
      const relativePath =
        folder === undefined
          ? document.uri.fsPath
          : path
              .relative(folder.uri.fsPath, document.uri.fsPath)
              .replaceAll(path.sep, "/");
      byUri.set(
        document.uri.toString(),
        byUri.get(document.uri.toString()) ?? {
          uri: document.uri.toString(),
          relativePath,
          rootId: folder?.uri.toString() ?? "open editors",
          score: 1,
          positions: [],
        },
      );
    }
    return [...byUri.values()].slice(0, this.options.maxResults());
  }
}
