import * as vscode from "vscode";
import type { SearchConfiguration, WorkspaceRoot } from "../engine/protocol.js";

export type ResolvedConfiguration = {
  roots: WorkspaceRoot[];
  search: SearchConfiguration;
  maxResults: number;
  preserveInput: boolean;
  loggingLevel: "error" | "warn" | "info" | "debug";
};

export function resolveConfiguration(): ResolvedConfiguration {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = folders
    .filter((folder) => folder.uri.scheme === "file")
    .map((folder) => ({ id: folder.uri.toString(), path: folder.uri.fsPath }));
  const rootExcludes: Record<string, string[]> = {};
  const useIgnoreFilesByRoot: Record<string, boolean> = {};
  const followSymlinksByRoot: Record<string, boolean> = {};
  for (const folder of folders) {
    const configured = vscode.workspace
      .getConfiguration("files", folder.uri)
      .get<Record<string, boolean>>("exclude", {});
    rootExcludes[folder.uri.toString()] = Object.entries(configured)
      .filter(([, enabled]) => enabled)
      .map(([pattern]) => pattern);
    const search = vscode.workspace.getConfiguration("search", folder.uri);
    useIgnoreFilesByRoot[folder.uri.toString()] = search.get(
      "useIgnoreFiles",
      true,
    );
    followSymlinksByRoot[folder.uri.toString()] = search.get(
      "followSymlinks",
      false,
    );
  }
  const fast = vscode.workspace.getConfiguration("fastSearch");
  const explicitPreserve = fast.get<boolean | null>(
    "filePicker.preserveInput",
    null,
  );
  const logging = fast.get<string>("logging.level", "warn");
  const loggingLevel =
    logging === "error" || logging === "info" || logging === "debug"
      ? logging
      : "warn";
  return {
    roots,
    search: {
      excludes: [],
      rootExcludes,
      useIgnoreFiles: true,
      useIgnoreFilesByRoot,
      followSymlinks: false,
      followSymlinksByRoot,
    },
    maxResults: fast.get("filePicker.maxResults", 100),
    preserveInput:
      explicitPreserve ??
      vscode.workspace
        .getConfiguration("search")
        .get("quickAccess.preserveInput", false),
    loggingLevel,
  };
}

export function workspaceProblem(): string | undefined {
  if (process.platform !== "darwin")
    return "Fast Search v1 supports local macOS workspaces only.";
  if (!vscode.workspace.isTrusted)
    return "Trust this workspace to start the local Fast Search engine.";
  const folders = vscode.workspace.workspaceFolders;
  if (folders === undefined || folders.length === 0)
    return "Open a folder or workspace to use Fast Search.";
  if (folders.some((folder) => folder.uri.scheme !== "file"))
    return "Fast Search v1 does not support remote or non-file workspace folders.";
  return undefined;
}
