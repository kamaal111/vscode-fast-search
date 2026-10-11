import { afterEach, expect, it, vi } from "vitest";
import type {
  EngineClient,
  TextSearchCallbacks,
} from "../../src/engine/client.js";
import type {
  Diagnostics,
  TextSearchOptions,
} from "../../src/engine/protocol.js";
import { SearchModel } from "../../src/searchView/model.js";

afterEach(() => vi.useRealTimers());

function emitFirstBatch(callbacks: TextSearchCallbacks[]): void {
  const callback = callbacks[0];
  if (callback === undefined)
    throw new Error("expected first search callbacks");
  callback.onBatch([
    {
      uri: "file:///old",
      rootId: "r",
      line: 0,
      startColumn: 0,
      endLine: 0,
      endColumn: 1,
      preview: "old",
      previewStart: 0,
      previewEnd: 1,
    },
  ]);
}

it("debounces search-on-type and suppresses a stale batch", () => {
  vi.useFakeTimers();
  const callbacks: TextSearchCallbacks[] = [];
  const engine: EngineClient = {
    initialize: async () => undefined,
    reconfigure: async () => undefined,
    fileSearch: async () => [],
    rebuild: async () => undefined,
    shutdown: async () => undefined,
    diagnostics: async (): Promise<Diagnostics> => ({
      ready: true,
      fileCount: 0,
      roots: 0,
      generation: 1,
    }),
    textSearch: (
      _query: string,
      _options: TextSearchOptions,
      _overlays,
      next,
    ) => {
      callbacks.push(next);
      return { requestId: String(callbacks.length), cancel: vi.fn() };
    },
  };
  const states: number[] = [];
  const model = new SearchModel({
    engine,
    debounceMs: () => 20,
    searchOnType: () => true,
    overlays: () => [],
    encoding: () => undefined,
    onChange: (state) => states.push(state.results.length),
  });
  model.update({ query: "first" });
  vi.advanceTimersByTime(20);
  model.update({ query: "second" });
  vi.advanceTimersByTime(20);
  expect(callbacks).toHaveLength(2);
  emitFirstBatch(callbacks);
  expect(model.current().results).toEqual([]);
  expect(states.at(-1)).toBe(0);
  model.dispose();
  vi.useRealTimers();
});

function timedSearch(searchOnType = false) {
  const callbacks: TextSearchCallbacks[] = [];
  const engine: EngineClient = {
    initialize: async () => undefined,
    reconfigure: async () => undefined,
    fileSearch: async () => [],
    rebuild: async () => undefined,
    shutdown: async () => undefined,
    diagnostics: async () => ({
      ready: true,
      fileCount: 0,
      roots: 0,
      generation: 1,
    }),
    textSearch: (_query, _options, _overlays, next) => {
      callbacks.push(next);
      return { requestId: String(callbacks.length), cancel: vi.fn() };
    },
  };
  const model = new SearchModel({
    engine,
    debounceMs: () => 20,
    searchOnType: () => searchOnType,
    overlays: () => [],
    encoding: () => undefined,
    onChange: vi.fn(),
  });
  const callback = (index = 0): TextSearchCallbacks => {
    const found = callbacks[index];
    if (found === undefined) throw new Error("Search not started");
    return found;
  };
  const complete = (index = 0, cancelled = false): void =>
    callback(index).onComplete({
      resultCount: model.current().results.length,
      limitHit: false,
      cancelled,
      warnings: [],
    });
  return { model, callbacks, callback, complete };
}

it("measures dispatch through all batches without the typing debounce", () => {
  vi.useFakeTimers();
  const { model, callbacks, complete } = timedSearch(true);
  model.update({ query: "match" });
  expect(model.current().elapsedMs).toBeUndefined();
  vi.advanceTimersByTime(20);
  vi.advanceTimersByTime(12);
  emitFirstBatch(callbacks);
  expect(model.current().elapsedMs).toBeUndefined();
  vi.advanceTimersByTime(30);
  emitFirstBatch(callbacks);
  complete();
  expect(model.current().elapsedMs).toBe(42);
  expect(model.current().searching).toBe(false);
  expect(model.current().results).toHaveLength(2);
  model.dismissFile(model.current().session, "file:///old");
  expect(model.current().elapsedMs).toBe(42);
  model.dispose();
  vi.useRealTimers();
});

it("records zero-result completion and resets duration for a new or empty search", () => {
  vi.useFakeTimers();
  const { model, complete } = timedSearch();
  model.update({ query: "first" });
  model.search();
  complete();
  expect(model.current().elapsedMs).toBe(0);
  model.update({ query: "second" });
  model.search();
  expect(model.current().elapsedMs).toBeUndefined();
  vi.advanceTimersByTime(1240);
  complete(1);
  expect(model.current().elapsedMs).toBe(1240);
  model.update({ query: "" });
  model.search();
  expect(model.current().elapsedMs).toBeUndefined();
  model.dispose();
  vi.useRealTimers();
});

it("ignores stale completions and errors after a replacement search", () => {
  vi.useFakeTimers();
  const { model, callback, complete } = timedSearch();
  model.update({ query: "first" });
  model.search();
  vi.advanceTimersByTime(10);
  model.update({ query: "second" });
  model.search();
  vi.advanceTimersByTime(42);
  complete(1);
  complete(0);
  callback(0).onError(new Error("stale"));
  expect(model.current().elapsedMs).toBe(42);
  expect(model.current().error).toBeUndefined();
  model.dispose();
  vi.useRealTimers();
});

it("clears completed duration on cancellation and ignores late completion", () => {
  vi.useFakeTimers();
  const { model, complete } = timedSearch();
  model.update({ query: "match" });
  model.search();
  vi.advanceTimersByTime(42);
  complete();
  model.cancel();
  complete();
  expect(model.current().elapsedMs).toBeUndefined();
  expect(model.current().searching).toBe(false);
  model.dispose();
  vi.useRealTimers();
});

it("does not record duration for cancelled completion or search error", () => {
  vi.useFakeTimers();
  const { model, callback, complete } = timedSearch();
  model.update({ query: "match" });
  model.search();
  vi.advanceTimersByTime(42);
  complete(0, true);
  expect(model.current().elapsedMs).toBeUndefined();
  model.search();
  vi.advanceTimersByTime(10);
  callback(1).onError(new Error("failed"));
  expect(model.current().elapsedMs).toBeUndefined();
  expect(model.current().error).toBe("failed");
  model.dispose();
  vi.useRealTimers();
});
