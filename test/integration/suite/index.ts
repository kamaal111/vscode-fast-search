import { equal, ok } from "node:assert/strict";
import * as vscode from "vscode";
import { IconTheme } from "../../../src/searchView/iconTheme.js";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("kamaal.vscode-fast-search");
  ok(extension);
  await vscode.commands.executeCommand("fastSearch.showDiagnostics");
  equal(extension.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  equal(commands.includes("fastSearch.openFile"), true);
  equal(commands.includes("fastSearch.findInFiles"), true);
  equal(commands.includes("fastSearch.rebuildIndex"), true);
  equal(commands.includes("fastSearch.showDiagnostics"), true);
  await vscode.commands.executeCommand("fastSearch.rebuildIndex");
  await verifyIconThemes();
}

async function verifyIconThemes(): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "fastSearch.iconTest",
    "Icon theme integration",
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
  );
  const icons = new IconTheme({
    webview: () => panel.webview,
    changed: () => undefined,
  });
  const config = vscode.workspace.getConfiguration("workbench");
  const previous = config.get<string | null>("iconTheme");
  try {
    await config.update(
      "iconTheme",
      "vs-seti",
      vscode.ConfigurationTarget.Global,
    );
    await icons.reload();
    ok(icons.css.includes("@font-face"));
    ok(icons.css.includes(".woff"));
    const typescript = vscode.Uri.file("/workspace/src/example.ts");
    ok(icons.icon(typescript));
    await config.update(
      "iconTheme",
      "fast-search-test-icons",
      vscode.ConfigurationTarget.Global,
    );
    await icons.reload();
    const pnpm = icons.icon(vscode.Uri.file("/workspace/pnpm-workspace.yaml"));
    const ts = icons.icon(typescript);
    ok(pnpm);
    ok(ts);
    ok(pnpm !== ts);
    ok(icons.css.includes("pnpm.svg"));
    ok(icons.css.includes("typescript.svg"));
    ok(
      icons.roots.some((root) => root.path.endsWith("fast-search-test-icons")),
    );
    await config.update("iconTheme", null, vscode.ConfigurationTarget.Global);
    await icons.reload();
    equal(icons.css, "");
    equal(icons.icon(typescript), undefined);
    equal(icons.roots.length, 0);
  } finally {
    icons.dispose();
    panel.dispose();
    await config.update(
      "iconTheme",
      previous,
      vscode.ConfigurationTarget.Global,
    );
  }
}
