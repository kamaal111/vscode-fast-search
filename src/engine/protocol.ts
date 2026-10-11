export const protocolVersion = 1;

export type WorkspaceRoot = { id: string; path: string; name?: string };
export type ExclusionRule = string | { pattern: string; when: string };
export type SearchConfiguration = {
  excludes: string[];
  rootExcludes: Record<string, ExclusionRule[]>;
  useIgnoreFiles: boolean;
  useIgnoreFilesByRoot: Record<string, boolean>;
  useGlobalIgnoreFiles: boolean;
  useGlobalIgnoreFilesByRoot: Record<string, boolean>;
  useParentIgnoreFiles: boolean;
  useParentIgnoreFilesByRoot: Record<string, boolean>;
  followSymlinks: boolean;
  followSymlinksByRoot: Record<string, boolean>;
};
export type ActiveEditor = { uri: string; directory: string };
export type DocumentOverlay = {
  uri: string;
  text: string;
  encoding?: string;
  untitled: boolean;
};
export type TextSearchOptions = {
  encoding?: string;
  regex: boolean;
  caseSensitive: boolean;
  smartCase: boolean;
  wholeWord: boolean;
  multiline: boolean;
  includes: string[];
  excludes: string[];
  maxResults: number;
};

type RequestBase = { version: number; requestId: string };
export type EngineRequest =
  | (RequestBase & {
      type: "initialize" | "reconfigure";
      roots: WorkspaceRoot[];
      configuration: SearchConfiguration;
    })
  | (RequestBase & {
      type: "fileSearch";
      query: string;
      maxResults: number;
      activeEditor?: ActiveEditor;
    })
  | (RequestBase & {
      type: "textSearch";
      query: string;
      options: TextSearchOptions;
      overlays: DocumentOverlay[];
    })
  | (RequestBase & { type: "cancel"; targetRequestId: string })
  | (RequestBase & { type: "status" | "shutdown" });

export type FileMatch = {
  uri: string;
  relativePath: string;
  rootId: string;
  score: number;
  positions: number[];
  line?: number | null;
  column?: number | null;
};
export type TextMatch = {
  uri: string;
  rootId: string;
  line: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  preview: string;
  previewStart: number;
  previewEnd: number;
};
export type Diagnostics = {
  ready: boolean;
  fileCount: number;
  roots: number;
  generation: number;
  lastError?: string | null;
};
export type EngineMessage =
  | (RequestBase & {
      type: "indexProgress";
      rootId: string;
      filesIndexed: number;
    })
  | (RequestBase & { type: "indexReady"; fileCount: number })
  | (RequestBase & {
      type: "fileResults";
      results: FileMatch[];
      partial: boolean;
    })
  | (RequestBase & { type: "textResultBatch"; results: TextMatch[] })
  | (RequestBase & {
      type: "textSearchComplete";
      resultCount: number;
      limitHit: boolean;
      cancelled: boolean;
      warnings: string[];
    })
  | (RequestBase & { type: "requestError"; code: string; message: string })
  | (RequestBase & { type: "diagnostics" } & Diagnostics);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function isNonNegativeInteger(value: unknown): value is number {
  return isNumber(value) && Number.isInteger(value) && value >= 0;
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}
function isFileMatch(value: unknown): value is FileMatch {
  return (
    isRecord(value) &&
    isString(value.uri) &&
    isString(value.relativePath) &&
    isString(value.rootId) &&
    isNumber(value.score) &&
    Array.isArray(value.positions) &&
    value.positions.every(isNonNegativeInteger) &&
    (value.line === undefined ||
      value.line === null ||
      isNonNegativeInteger(value.line)) &&
    (value.column === undefined ||
      value.column === null ||
      isNonNegativeInteger(value.column))
  );
}
function isTextMatch(value: unknown): value is TextMatch {
  return (
    isRecord(value) &&
    isString(value.uri) &&
    isString(value.rootId) &&
    isNonNegativeInteger(value.line) &&
    isNonNegativeInteger(value.startColumn) &&
    isNonNegativeInteger(value.endLine) &&
    isNonNegativeInteger(value.endColumn) &&
    isString(value.preview) &&
    isNonNegativeInteger(value.previewStart) &&
    isNonNegativeInteger(value.previewEnd) &&
    value.line <= value.endLine &&
    (value.line < value.endLine || value.startColumn <= value.endColumn) &&
    value.previewStart <= value.previewEnd &&
    value.previewEnd <= value.preview.length
  );
}

export function decodeMessage(line: string): EngineMessage {
  const value: unknown = JSON.parse(line);
  if (
    !isRecord(value) ||
    value.version !== protocolVersion ||
    !isString(value.requestId) ||
    !isString(value.type)
  )
    throw new Error("Invalid protocol envelope");
  switch (value.type) {
    case "indexProgress":
      if (isString(value.rootId) && isNonNegativeInteger(value.filesIndexed))
        return value as EngineMessage;
      break;
    case "indexReady":
      if (isNonNegativeInteger(value.fileCount)) return value as EngineMessage;
      break;
    case "fileResults":
      if (
        Array.isArray(value.results) &&
        value.results.every(isFileMatch) &&
        isBoolean(value.partial)
      )
        return value as EngineMessage;
      break;
    case "textResultBatch":
      if (Array.isArray(value.results) && value.results.every(isTextMatch))
        return value as EngineMessage;
      break;
    case "textSearchComplete":
      if (
        isNonNegativeInteger(value.resultCount) &&
        isBoolean(value.limitHit) &&
        isBoolean(value.cancelled) &&
        isStringArray(value.warnings)
      )
        return value as EngineMessage;
      break;
    case "requestError":
      if (isString(value.code) && isString(value.message))
        return value as EngineMessage;
      break;
    case "diagnostics":
      if (
        isBoolean(value.ready) &&
        isNonNegativeInteger(value.fileCount) &&
        isNonNegativeInteger(value.roots) &&
        isNonNegativeInteger(value.generation) &&
        (value.lastError === undefined ||
          value.lastError === null ||
          isString(value.lastError))
      )
        return value as EngineMessage;
      break;
  }
  throw new Error(`Invalid ${value.type} message`);
}

export class LineDecoder {
  private buffered = "";
  push(fragment: string): string[] {
    this.buffered += fragment;
    const lines = this.buffered.split("\n");
    this.buffered = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  }
}
