import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/platform/hash";

describe("sha256Hex", () => {
  it("matches standard SHA-256 test vectors", async () => {
    expect(await sha256Hex(new TextEncoder().encode(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256Hex(new TextEncoder().encode("The quick brown fox jumps over the lazy dog"))).toBe(
      "d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592",
    );
  });

  it("accepts both Uint8Array and ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode("hello");
    const copy = new Uint8Array(bytes.length);
    copy.set(bytes);
    const fromTyped = await sha256Hex(bytes);
    const fromBuffer = await sha256Hex(copy.buffer);
    expect(fromTyped).toBe(fromBuffer);
    expect(fromTyped).toHaveLength(64);
  });
});
