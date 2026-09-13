import type {
  ActiveEditor,
  Diagnostics,
  DocumentOverlay,
  FileMatch,
  SearchConfiguration,
  TextMatch,
  TextSearchOptions,
  WorkspaceRoot,
} from "./protocol.js";

export type TextSearchCallbacks = {
  onBatch(results: TextMatch[]): void;
  onComplete(summary: {
    resultCount: number;
    limitHit: boolean;
    cancelled: boolean;
    warnings: string[];
  }): void;
  onError(error: Error): void;
};
export type SearchHandle = { requestId: string; cancel(): void };

export interface EngineClient {
  initialize(
    roots: WorkspaceRoot[],
    configuration: SearchConfiguration,
  ): Promise<void>;
  reconfigure(
    roots: WorkspaceRoot[],
    configuration: SearchConfiguration,
  ): Promise<void>;
  fileSearch(
    query: string,
    maxResults: number,
    activeEditor?: ActiveEditor,
  ): Promise<FileMatch[]>;
  textSearch(
    query: string,
    options: TextSearchOptions,
    overlays: DocumentOverlay[],
    callbacks: TextSearchCallbacks,
  ): SearchHandle;
  rebuild(): Promise<void>;
  diagnostics(): Promise<Diagnostics>;
  shutdown(): Promise<void>;
}
