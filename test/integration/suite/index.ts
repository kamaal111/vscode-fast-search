import { equal, ok } from "node:assert/strict";
import * as vscode from "vscode";

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
}
