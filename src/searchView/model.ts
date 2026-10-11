import type {
  DocumentOverlay,
  TextMatch,
  TextSearchOptions,
} from "../engine/protocol.js";
import type { EngineClient, SearchHandle } from "../engine/client.js";

export type SearchState = {
  session: number;
  query: string;
  include: string;
  exclude: string;
  options: Omit<TextSearchOptions, "includes" | "excludes" | "maxResults">;
  searching: boolean;
  results: TextMatch[];
  warnings: string[];
  error: string | undefined;
};
export type SearchModelOptions = {
  engine: EngineClient;
  debounceMs(): number;
  searchOnType(): boolean;
  overlays(): DocumentOverlay[];
  encoding(): string | undefined;
  onChange(state: SearchState): void;
  onSearch?(fields: Pick<SearchState, "query" | "include" | "exclude">): void;
};

const initialOptions = {
  regex: false,
  caseSensitive: false,
  smartCase: true,
  wholeWord: false,
  multiline: false,
};
export class SearchModel {
  private state: SearchState = {
    session: 0,
    query: "",
    include: "",
    exclude: "",
    options: initialOptions,
    searching: false,
    results: [],
    warnings: [],
    error: undefined,
  };
  private timer: NodeJS.Timeout | undefined;
  private active: SearchHandle | undefined;
  private generation = 0;
  private readonly dismissedMatches = new Set<string>();
  private readonly dismissedFiles = new Set<string>();
  constructor(private readonly config: SearchModelOptions) {}
  current(): SearchState {
    return this.state;
  }
  update(
    patch: Partial<Pick<SearchState, "query" | "include" | "exclude">> & {
      options?: Partial<SearchState["options"]>;
    },
  ): void {
    this.state = {
      ...this.state,
      ...patch,
      options: { ...this.state.options, ...patch.options },
    };
    this.emit();
    if (this.config.searchOnType()) this.schedule();
  }
  schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.search(), this.config.debounceMs());
  }
  search(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.active?.cancel();
    const generation = ++this.generation;
    this.dismissedMatches.clear();
    this.dismissedFiles.clear();
    this.state = { ...this.state, session: this.state.session + 1 };
    if (this.state.query.length === 0) {
      this.state = {
        ...this.state,
        searching: false,
        results: [],
        warnings: [],
      };
      this.emit();
      return;
    }
    this.config.onSearch?.({
      query: this.state.query,
      include: this.state.include,
      exclude: this.state.exclude,
    });
    this.state = {
      ...this.state,
      searching: true,
      results: [],
      warnings: [],
      error: undefined,
    };
    this.emit();
    const split = (value: string): string[] =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);
    const encoding = this.config.encoding();
    this.active = this.config.engine.textSearch(
      this.state.query,
      {
        ...this.state.options,
        includes: split(this.state.include),
        excludes: split(this.state.exclude),
        maxResults: 10_000,
        ...(encoding === undefined ? {} : { encoding }),
      },
      this.config.overlays(),
      {
        onBatch: (results) => {
          if (generation === this.generation) {
            this.state = {
              ...this.state,
              results: [
                ...this.state.results,
                ...results.filter(
                  (match) =>
                    !this.dismissedFiles.has(match.uri) &&
                    !this.dismissedMatches.has(resultId(match)),
                ),
              ].sort(compareMatches),
            };
            this.emit();
          }
        },
        onComplete: (summary) => {
          if (generation === this.generation) {
            this.state = {
              ...this.state,
              searching: false,
              warnings: summary.warnings,
            };
            this.emit();
          }
        },
        onError: (error) => {
          if (generation === this.generation) {
            this.state = {
              ...this.state,
              searching: false,
              error: error.message,
            };
            this.emit();
          }
        },
      },
    );
  }
  dismissMatch(session: number, id: string): void {
    if (
      session !== this.state.session ||
      !this.state.results.some((match) => resultId(match) === id)
    )
      return;
    this.dismissedMatches.add(id);
    this.state = {
      ...this.state,
      results: this.state.results.filter((match) => resultId(match) !== id),
    };
    this.emit();
  }
  dismissFile(session: number, uri: string): void {
    if (
      session !== this.state.session ||
      !this.state.results.some((match) => match.uri === uri)
    )
      return;
    this.dismissedFiles.add(uri);
    this.state = {
      ...this.state,
      results: this.state.results.filter((match) => match.uri !== uri),
    };
    this.emit();
  }
  cancel(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.generation += 1;
    this.active?.cancel();
    this.state = { ...this.state, searching: false };
    this.emit();
  }
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.active?.cancel();
  }
  private emit(): void {
    this.config.onChange(this.state);
  }
}

function compareMatches(left: TextMatch, right: TextMatch): number {
  return (
    left.uri.localeCompare(right.uri) ||
    left.line - right.line ||
    left.startColumn - right.startColumn ||
    left.endLine - right.endLine ||
    left.endColumn - right.endColumn
  );
}

export function resultId(match: TextMatch): string {
  return JSON.stringify([
    match.uri,
    match.line,
    match.startColumn,
    match.endLine,
    match.endColumn,
  ]);
}
