import * as path from "node:path";
import * as vscode from "vscode";
import {
  resolveConfiguration,
  workspaceProblem,
} from "../configuration/configuration.js";
import { ProcessEngineClient } from "../engine/processClient.js";
import { FilePicker } from "../filePicker/filePicker.js";
import { SearchViewProvider } from "../searchView/provider.js";

let engine: ProcessEngineClient | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const output = vscode.window.createOutputChannel("Fast Search", {
    log: true,
  });
  let permanentFailure: Error | undefined;
  let searchView: SearchViewProvider | undefined;
  engine = new ProcessEngineClient({
    executable: path.join(context.extensionPath, "bin", "fast-search-engine"),
    log: (message) => output.appendLine(message),
    onIndexProgress: (rootId, filesIndexed) => {
      const level = resolveConfiguration().loggingLevel;
      if (level === "info" || level === "debug")
        output.appendLine(`Indexing ${rootId}: ${filesIndexed} files`);
      searchView?.setIndexProgress(rootId, filesIndexed);
    },
    onIndexReady: (fileCount) => searchView?.setIndexReady(fileCount),
    onPermanentFailure: (error) => {
      permanentFailure = error;
      void vscode.window.showErrorMessage(
        "Fast Search stopped after a repeated engine crash. Open diagnostics for details.",
      );
    },
  });
  const picker = new FilePicker({
    engine,
    maxResults: () => resolveConfiguration().maxResults,
    preserveInput: () => resolveConfiguration().preserveInput,
  });
  searchView = new SearchViewProvider({
    extensionUri: context.extensionUri,
    engine,
    workspaceState: context.workspaceState,
  });

  const initialize = async (): Promise<void> => {
    const problem = workspaceProblem();
    if (problem !== undefined) {
      output.appendLine(problem);
      return;
    }
    const config = resolveConfiguration();
    await engine?.initialize(config.roots, config.search);
  };
  const reconfigure = async (): Promise<void> => {
    if (workspaceProblem() !== undefined) return;
    const config = resolveConfiguration();
    await engine?.reconfigure(config.roots, config.search);
  };
  const usable = (): boolean => {
    const problem = workspaceProblem();
    if (problem === undefined) return true;
    void vscode.window.showInformationMessage(problem);
    return false;
  };

  context.subscriptions.push(
    output,
    searchView,
    vscode.window.registerWebviewViewProvider(
      "fastSearch.searchView",
      searchView,
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand("fastSearch.openFile", async () => {
      if (usable()) await picker.show();
    }),
    vscode.commands.registerCommand("fastSearch.findInFiles", async () => {
      if (usable()) {
        await vscode.commands.executeCommand(
          "workbench.view.extension.fastSearch",
        );
        searchView.show();
      }
    }),
    vscode.commands.registerCommand("fastSearch.rebuildIndex", async () => {
      if (usable()) {
        await engine?.rebuild();
        void vscode.window.showInformationMessage("Fast Search index rebuilt.");
      }
    }),
    vscode.commands.registerCommand("fastSearch.showDiagnostics", async () => {
      output.show(true);
      if (permanentFailure !== undefined)
        output.appendLine(`Permanent failure: ${permanentFailure.message}`);
      try {
        output.appendLine(JSON.stringify(await engine?.diagnostics(), null, 2));
      } catch (error) {
        output.appendLine(
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
        );
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("files.exclude") ||
        event.affectsConfiguration("search") ||
        event.affectsConfiguration("fastSearch")
      )
        void reconfigure();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void reconfigure();
    }),
  );
  void initialize().catch((error: unknown) => {
    output.appendLine(
      `Initialization failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

export async function deactivate(): Promise<void> {
  await engine?.shutdown();
  engine = undefined;
}
