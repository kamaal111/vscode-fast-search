import { expect, it, vi } from "vitest";
import type {
  EngineClient,
  TextSearchCallbacks,
} from "../../src/engine/client.js";
import type {
  Diagnostics,
  TextSearchOptions,
} from "../../src/engine/protocol.js";
import { SearchModel } from "../../src/searchView/model.js";

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
