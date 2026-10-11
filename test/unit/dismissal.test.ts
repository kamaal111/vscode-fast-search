import { afterEach, expect, it, vi } from "vitest";
import type {
  EngineClient,
  TextSearchCallbacks,
} from "../../src/engine/client.js";
import type { TextMatch } from "../../src/engine/protocol.js";
import { SearchModel, resultId } from "../../src/searchView/model.js";

function match(
  line: number,
  uri = "file:///workspace/src/example.ts",
): TextMatch {
  return {
    uri,
    rootId: "workspace",
    line,
    startColumn: 0,
    endLine: line,
    endColumn: 5,
    preview: "match",
    previewStart: 0,
    previewEnd: 5,
  };
}
function setup(searchOnType = false) {
  let callbacks: TextSearchCallbacks | undefined;
  const cancel = vi.fn();
  const changed = vi.fn();
  const engine: EngineClient = {
    initialize: async () => undefined,
    reconfigure: async () => undefined,
    fileSearch: async () => [],
    rebuild: async () => undefined,
    diagnostics: async () => ({
      ready: true,
      fileCount: 0,
      roots: 1,
      generation: 1,
    }),
    shutdown: async () => undefined,
    textSearch: vi.fn((_query, _options, _overlays, next) => {
      callbacks = next;
      return { requestId: "1", cancel };
    }),
  };
  const model = new SearchModel({
    engine,
    debounceMs: () => 10,
    searchOnType: () => searchOnType,
    overlays: () => [],
    encoding: () => undefined,
    onChange: changed,
  });
  const batch = (matches: TextMatch[]): void => {
    if (callbacks === undefined) throw new Error("Search not started");
    callbacks.onBatch(matches);
  };
  const complete = (): void => {
    if (callbacks === undefined) throw new Error("Search not started");
    callbacks.onComplete({
      resultCount: 3,
      limitHit: false,
      cancelled: false,
      warnings: [],
    });
  };
  model.update({ query: "match" });
  model.search();
  return { model, batch, complete, cancel, changed, engine };
}
afterEach(() => vi.useRealTimers());

it("dismisses one exact range, decrements results, and removes the final match", () => {
  const { model, batch } = setup();
  batch([match(0), match(1)]);
  model.dismissMatch(1, resultId(match(0)));
  expect(model.current().results).toEqual([match(1)]);
  model.dismissMatch(1, resultId(match(1)));
  expect(model.current().results).toEqual([]);
  model.dispose();
});

it("keeps dismissed matches hidden in later batches and restores them on a new search", () => {
  const { model, batch } = setup();
  batch([match(0)]);
  model.dismissMatch(1, resultId(match(0)));
  batch([match(0), match(1)]);
  expect(model.current().results).toEqual([match(1)]);
  model.search();
  batch([match(0)]);
  expect(model.current().session).toBe(2);
  expect(model.current().results).toEqual([match(0)]);
  model.dispose();
});

it("dismisses a whole file including future batches without affecting another file", () => {
  const { model, batch, complete } = setup();
  const other = match(0, "file:///workspace/src/other.ts");
  batch([match(0), other]);
  model.dismissFile(1, match(0).uri);
  batch([match(1)]);
  complete();
  expect(model.current().results).toEqual([other]);
  expect(model.current().searching).toBe(false);
  model.search();
  batch([match(0)]);
  expect(model.current().results).toEqual([match(0)]);
  model.dispose();
});

it("ignores stale sessions, unknown targets, and repeated dismissals", () => {
  const { model, batch, changed } = setup();
  batch([match(0)]);
  changed.mockClear();
  model.dismissMatch(0, resultId(match(0)));
  model.dismissFile(0, match(0).uri);
  model.dismissMatch(1, "unknown");
  model.dismissFile(1, "file:///unknown");
  expect(changed).not.toHaveBeenCalled();
  expect(model.current().results).toEqual([match(0)]);
  model.dismissMatch(1, resultId(match(0)));
  model.dismissMatch(1, resultId(match(0)));
  expect(changed).toHaveBeenCalledTimes(1);
  model.dispose();
});

it("retains results and dismissal after cancellation while ignoring late batches", () => {
  const { model, batch, cancel } = setup();
  batch([match(0), match(1)]);
  model.dismissMatch(1, resultId(match(0)));
  model.cancel();
  batch([match(2)]);
  expect(cancel).toHaveBeenCalled();
  expect(model.current().session).toBe(1);
  expect(model.current().results).toEqual([match(1)]);
  model.dismissFile(1, match(1).uri);
  expect(model.current().results).toEqual([]);
  model.dispose();
});

it("cancels a pending debounced search as well as its active request", () => {
  vi.useFakeTimers();
  const { model, engine } = setup(true);
  model.update({ query: "next" });
  model.cancel();
  vi.advanceTimersByTime(20);
  expect(engine.textSearch).toHaveBeenCalledTimes(1);
  model.dispose();
});
