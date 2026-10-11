import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  EngineClient,
  SearchHandle,
  TextSearchCallbacks,
} from "./client.js";
import {
  decodeMessage,
  LineDecoder,
  protocolVersion,
  type ActiveEditor,
  type Diagnostics,
  type DocumentOverlay,
  type EngineMessage,
  type EngineRequest,
  type FileMatch,
  type SearchConfiguration,
  type TextSearchOptions,
  type WorkspaceRoot,
} from "./protocol.js";

type Pending = {
  resolve(message: EngineMessage): void;
  reject(error: Error): void;
  onMessage?: (message: EngineMessage) => boolean;
};
type ProcessClientOptions = {
  executable: string;
  log(message: string): void;
  onIndexProgress?(rootId: string, filesIndexed: number): void;
  onIndexReady?(fileCount: number): void;
  onPermanentFailure(error: Error): void;
};

export class ProcessEngineClient implements EngineClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<string, Pending>();
  private roots: WorkspaceRoot[] = [];
  private configuration: SearchConfiguration = {
    excludes: [],
    rootExcludes: {},
    useIgnoreFiles: true,
    useIgnoreFilesByRoot: {},
    useGlobalIgnoreFiles: false,
    useGlobalIgnoreFilesByRoot: {},
    useParentIgnoreFiles: false,
    useParentIgnoreFilesByRoot: {},
    followSymlinks: false,
    followSymlinksByRoot: {},
  };
  private restarted = false;
  private intentionalExit = false;

  constructor(private readonly options: ProcessClientOptions) {}

  async initialize(
    roots: WorkspaceRoot[],
    configuration: SearchConfiguration,
  ): Promise<void> {
    this.roots = roots;
    this.configuration = configuration;
    this.ensureProcess();
    await this.waitFor("indexReady", {
      type: "initialize",
      version: protocolVersion,
      requestId: randomUUID(),
      roots,
      configuration,
    });
  }
  async reconfigure(
    roots: WorkspaceRoot[],
    configuration: SearchConfiguration,
  ): Promise<void> {
    this.roots = roots;
    this.configuration = configuration;
    await this.waitFor("indexReady", {
      type: "reconfigure",
      version: protocolVersion,
      requestId: randomUUID(),
      roots,
      configuration,
    });
  }
  async fileSearch(
    query: string,
    maxResults: number,
    activeEditor?: ActiveEditor,
  ): Promise<FileMatch[]> {
    const request: EngineRequest = {
      type: "fileSearch",
      version: protocolVersion,
      requestId: randomUUID(),
      query,
      maxResults,
      ...(activeEditor === undefined ? {} : { activeEditor }),
    };
    const response = await this.waitFor("fileResults", request);
    return response.type === "fileResults" ? response.results : [];
  }
  textSearch(
    query: string,
    options: TextSearchOptions,
    overlays: DocumentOverlay[],
    callbacks: TextSearchCallbacks,
  ): SearchHandle {
    const requestId = randomUUID();
    this.pending.set(requestId, {
      resolve: () => undefined,
      reject: callbacks.onError,
      onMessage: (message) => {
        if (message.type === "textResultBatch")
          callbacks.onBatch(message.results);
        if (message.type === "requestError") {
          callbacks.onError(new Error(message.message));
          return true;
        }
        if (message.type === "textSearchComplete") {
          callbacks.onComplete(message);
          return true;
        }
        return false;
      },
    });
    this.send({
      type: "textSearch",
      version: protocolVersion,
      requestId,
      query,
      options,
      overlays,
    });
    return {
      requestId,
      cancel: () =>
        this.send({
          type: "cancel",
          version: protocolVersion,
          requestId: randomUUID(),
          targetRequestId: requestId,
        }),
    };
  }
  async rebuild(): Promise<void> {
    await this.reconfigure(this.roots, this.configuration);
  }
  async diagnostics(): Promise<Diagnostics> {
    const response = await this.waitFor("diagnostics", {
      type: "status",
      version: protocolVersion,
      requestId: randomUUID(),
    });
    if (response.type !== "diagnostics")
      throw new Error("Engine returned no diagnostics");
    return response;
  }
  async shutdown(): Promise<void> {
    if (this.child === undefined) return;
    this.intentionalExit = true;
    await this.waitFor("diagnostics", {
      type: "shutdown",
      version: protocolVersion,
      requestId: randomUUID(),
    });
    this.child = undefined;
  }

  private waitFor<T extends EngineMessage["type"]>(
    type: T,
    request: EngineRequest,
  ): Promise<EngineMessage> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, {
        resolve,
        reject,
        onMessage: (message) =>
          message.type === type || message.type === "requestError",
      });
      this.send(request);
    });
  }
  private send(request: EngineRequest): void {
    this.ensureProcess().stdin.write(`${JSON.stringify(request)}\n`);
  }
  private ensureProcess(): ChildProcessWithoutNullStreams {
    if (this.child !== undefined) return this.child;
    const child = spawn(this.options.executable, [], { stdio: "pipe" });
    this.child = child;
    const decoder = new LineDecoder();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (fragment: string) => {
      for (const line of decoder.push(fragment)) this.route(line);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => this.options.log(text.trimEnd()));
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => this.exited(code));
    return child;
  }
  private route(line: string): void {
    try {
      const message = decodeMessage(line);
      if (message.type === "indexProgress")
        this.options.onIndexProgress?.(message.rootId, message.filesIndexed);
      if (message.type === "indexReady")
        this.options.onIndexReady?.(message.fileCount);
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) return;
      if (pending.onMessage?.(message)) {
        this.pending.delete(message.requestId);
        message.type === "requestError"
          ? pending.reject(new Error(message.message))
          : pending.resolve(message);
      }
    } catch (error) {
      this.options.log(
        `protocol error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private exited(code: number | null): void {
    this.child = undefined;
    if (this.intentionalExit) return;
    const error = new Error(
      `Fast Search engine exited unexpectedly (${code ?? "signal"})`,
    );
    this.fail(error);
    if (!this.restarted) {
      this.restarted = true;
      void this.initialize(this.roots, this.configuration).catch(
        (restartError: unknown) =>
          this.options.onPermanentFailure(
            restartError instanceof Error ? restartError : error,
          ),
      );
    } else this.options.onPermanentFailure(error);
  }
}
