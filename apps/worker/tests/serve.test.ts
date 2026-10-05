import { describe, expect, it } from "vitest";
import { etagMatches, parseRange } from "../src/platform/serve";

describe("parseRange", () => {
  it("parses the common single-range forms", () => {
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-0", 10)).toEqual({ start: 0, end: 0 });
    expect(parseRange("bytes=1-2", 10)).toEqual({ start: 1, end: 2 });
    expect(parseRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    // A suffix longer than the object is the whole object.
    expect(parseRange("bytes=-500", 10)).toEqual({ start: 0, end: 9 });
  });

  it("clamps an end past the last byte", () => {
    expect(parseRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
  });

  it("reports a well-formed but unsatisfiable range", () => {
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=20-30", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  it("ignores a range naming an unknown unit", () => {
    // RFC 9110 §14.2: MUST ignore, which means a plain 200 rather than a 416.
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("seconds=0-1", 10)).toBeNull();
  });

  it("ignores a multi-range request", () => {
    // Serving the whole representation is valid; failing it is not, and PDF viewers and
    // ffmpeg do send these.
    expect(parseRange("bytes=0-1,3-4", 10)).toBeNull();
  });

  it("ignores malformed and empty range specifiers", () => {
    expect(parseRange("bytes=", 10)).toBeNull();
    expect(parseRange("bytes=abc", 10)).toBeNull();
    expect(parseRange("bytes=-", 10)).toBeNull();
    expect(parseRange("bytes=5-1", 10)).toBeNull();
    expect(parseRange("bytes=-0", 10)).toBeNull();
    expect(parseRange("nonsense", 10)).toBeNull();
    expect(parseRange(null, 10)).toBeNull();
  });

  it("tolerates surrounding whitespace and a missing end bound", () => {
    expect(parseRange("  bytes=0-1  ", 10)).toEqual({ start: 0, end: 1 });
  });
});

describe("etagMatches", () => {
  it("matches exactly, weakly, in a list, and the wildcard", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches("*", '"abc"')).toBe(true);
  });

  it("does not match a different validator", () => {
    expect(etagMatches('"other"', '"abc"')).toBe(false);
    expect(etagMatches('"ab"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
    expect(etagMatches("", '"abc"')).toBe(false);
  });
});
