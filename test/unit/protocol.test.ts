import { describe, expect, it } from "vitest";
import { decodeMessage, LineDecoder } from "../../src/engine/protocol.js";

describe("protocol decoding", () => {
  it("reassembles fragmented newline-delimited messages", () => {
    const decoder = new LineDecoder();
    expect(decoder.push('{"type":"index')).toEqual([]);
    expect(
      decoder.push('Ready","version":1,"requestId":"a","fileCount":2}\n'),
    ).toEqual([
      '{"type":"indexReady","version":1,"requestId":"a","fileCount":2}',
    ]);
  });
  it("rejects a message whose payload shape is invalid", () => {
    expect(() =>
      decodeMessage(
        '{"type":"fileResults","version":1,"requestId":"a","results":"bad","partial":false}',
      ),
    ).toThrow("Invalid fileResults message");
  });
});
