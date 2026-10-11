import * as vscode from "vscode";
import { minimatch } from "minimatch";
import { FileIcons, object } from "./fileIcons.js";

type LanguageAssociation = { id: string; pattern: string; score: number };
type LoadedTheme = { icons: FileIcons; roots: vscode.Uri[] };

/** Bridges public extension contributions to the isolated search webview. */
export class IconTheme implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private loaded: LoadedTheme | undefined;
  private languages: LanguageAssociation[] = [];
  private readonly cache = new Map<string, string | undefined>();
  private revision = 0;
  private disposed = false;
  constructor(
    private readonly options: {
      webview(): vscode.Webview | undefined;
      changed(): void;
    },
  ) {
    this.subscriptions = [
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("workbench.iconTheme") ||
          event.affectsConfiguration("files.associations")
        )
          void this.reload();
      }),
      vscode.extensions.onDidChange(() => void this.reload()),
      vscode.window.onDidChangeActiveColorTheme(() => {
        this.cache.clear();
        this.options.changed();
      }),
      vscode.workspace.onDidOpenTextDocument(() => {
        this.cache.clear();
        this.options.changed();
      }),
      vscode.workspace.onDidCloseTextDocument(() => {
        this.cache.clear();
        this.options.changed();
      }),
    ];
  }

  get roots(): vscode.Uri[] {
    return this.loaded?.roots ?? [];
  }
  get css(): string {
    return this.loaded?.icons.css ?? "";
  }
  async reload(): Promise<void> {
    const revision = ++this.revision;
    this.languages = [];
    const selected = vscode.workspace
      .getConfiguration("workbench")
      .get<string | null>("iconTheme");
    let theme: { root: vscode.Uri; uri: vscode.Uri } | undefined;
    const languageIcons = new Map<string, { light: string; dark: string }>();
    const languageRoots = new Map<string, vscode.Uri>();
    const webview = this.options.webview();
    if (webview === undefined) return;
    for (const extension of vscode.extensions.all) {
      const manifest: unknown = extension.packageJSON;
      const contributions = object(object(manifest)?.contributes);
      if (Array.isArray(contributions?.iconThemes)) {
        for (const raw of contributions.iconThemes) {
          const item = object(raw);
          if (
            item !== undefined &&
            item.id === selected &&
            typeof item.path === "string"
          )
            theme = {
              root: extension.extensionUri,
              uri: vscode.Uri.joinPath(extension.extensionUri, item.path),
            };
        }
      }
      if (Array.isArray(contributions?.languages)) {
        for (const raw of contributions.languages) {
          const language = object(raw);
          if (typeof language?.id !== "string") continue;
          const id = language.id;
          const icon = object(language.icon);
          if (
            typeof icon?.light === "string" &&
            typeof icon.dark === "string"
          ) {
            const light = localResource({
              root: extension.extensionUri,
              directory: extension.extensionUri,
              path: icon.light,
              webview,
            });
            const dark = localResource({
              root: extension.extensionUri,
              directory: extension.extensionUri,
              path: icon.dark,
              webview,
            });
            if (light !== undefined && dark !== undefined) {
              languageIcons.set(id, { light, dark });
              languageRoots.set(
                extension.extensionUri.toString(),
                extension.extensionUri,
              );
            }
          }
          for (const pattern of strings(language.extensions))
            this.languages.push({
              id,
              pattern: `*${pattern}`,
              score: pattern.length,
            });
          for (const pattern of strings(language.filenamePatterns))
            this.languages.push({ id, pattern, score: 100 + pattern.length });
          for (const pattern of strings(language.filenames))
            this.languages.push({ id, pattern, score: 1000 + pattern.length });
        }
      }
    }
    let loaded: LoadedTheme | undefined;
    if (theme !== undefined && selected !== null) {
      try {
        const root = theme.root;
        const directory = vscode.Uri.joinPath(theme.uri, "..");
        const bytes = await vscode.workspace.fs.readFile(theme.uri);
        const icons = new FileIcons({
          source: new TextDecoder().decode(bytes),
          languageIcons,
          resource: (path) => localResource({ root, directory, path, webview }),
        });
        loaded = { icons, roots: [root, ...languageRoots.values()] };
      } catch (error) {
        console.warn(
          "Fast Search could not load the selected file icon theme",
          error,
        );
      }
    }
    if (this.disposed || revision !== this.revision) return;
    this.loaded = loaded;
    this.cache.clear();
    this.options.changed();
  }

  icon(uri: vscode.Uri): string | undefined {
    const key = uri.toString();
    if (this.cache.has(key)) return this.cache.get(key);
    const icon = this.loaded?.icons.icon({
      path: uri.path,
      language: this.language(uri),
      kind:
        vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
          ? "light"
          : vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
            ? "dark"
            : vscode.window.activeColorTheme.kind ===
                vscode.ColorThemeKind.HighContrastLight
              ? "highContrastLight"
              : "highContrast",
    });
    this.cache.set(key, icon);
    return icon;
  }

  dispose(): void {
    this.disposed = true;
    this.revision += 1;
    for (const subscription of this.subscriptions) subscription.dispose();
  }
  private language(uri: vscode.Uri): string | undefined {
    const open = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (open !== undefined && open.languageId !== "plaintext")
      return open.languageId;
    const configured: unknown = vscode.workspace
      .getConfiguration("files", uri)
      .get("associations", {});
    const overrides = Object.entries(object(configured) ?? {}).flatMap(
      ([pattern, id]) =>
        typeof id === "string"
          ? [{ pattern, id, score: 10_000 + pattern.length }]
          : [],
    );
    const filename = uri.path.split("/").at(-1) ?? "";
    return [...this.languages, ...overrides]
      .filter(({ pattern }) =>
        minimatch(pattern.includes("/") ? uri.path : filename, pattern, {
          nocase: true,
          dot: true,
        }),
      )
      .sort((left, right) => right.score - left.score)[0]?.id;
  }
}

function localResource({
  root,
  directory,
  path,
  webview,
}: {
  root: vscode.Uri;
  directory: vscode.Uri;
  path: string;
  webview: vscode.Webview;
}): string | undefined {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith("/"))
    return undefined;
  const uri = vscode.Uri.joinPath(directory, path);
  if (
    uri.scheme !== root.scheme ||
    uri.authority !== root.authority ||
    !uri.path.startsWith(`${root.path}/`)
  )
    return undefined;
  return webview.asWebviewUri(uri).toString();
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item: unknown): item is string => typeof item === "string")
    : [];
}
