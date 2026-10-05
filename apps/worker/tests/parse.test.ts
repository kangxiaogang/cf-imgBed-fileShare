import { describe, expect, it } from "vitest";
import {
  asFile,
  boundedNumber,
  bool,
  expirationToISO,
  finiteNumber,
  isExpired,
  nonEmptyString,
  parseDate,
  parseExpirationDays,
  parsePartNumber,
  positiveInt,
  str,
  strictPositiveInt,
  tryDecode,
  useMultipart,
} from "../src/platform/parse";

describe("parseExpirationDays", () => {
  it("returns null for empty or invalid input", () => {
    expect(parseExpirationDays(null)).toBeNull();
    expect(parseExpirationDays("")).toBeNull();
    expect(parseExpirationDays("0")).toBeNull();
    expect(parseExpirationDays("-8")).toBeNull();
    expect(parseExpirationDays("abc")).toBeNull();
  });

  it("returns positive numbers and caps very large values", () => {
    expect(parseExpirationDays("1")).toBe(1);
    expect(parseExpirationDays("3651")).toBe(3650);
  });
});

describe("expirationToISO and isExpired", () => {
  it("returns null when no expiration is set", () => {
    expect(expirationToISO(null)).toBeNull();
    expect(expirationToISO(0)).toBeNull();
  });

  it("generates a future timestamp and checks expiration", () => {
    const iso = expirationToISO(1);
    expect(iso).toBeTruthy();
    expect(isExpired(iso)).toBe(false);
    expect(isExpired("2000-01-01T00:00:00.000Z")).toBe(true);
    expect(isExpired("not-a-date")).toBe(false);
    expect(isExpired(null)).toBe(false);
  });
});

describe("parseDate", () => {
  it("parses valid dates and rejects invalid values", () => {
    expect(parseDate("2026-02-11T00:00:00Z")).toBe("2026-02-11T00:00:00.000Z");
    expect(parseDate("")).toBeNull();
    expect(parseDate(123)).toBeNull();
    expect(parseDate("invalid")).toBeNull();
  });
});

describe("parsePartNumber", () => {
  it("accepts positive integers", () => {
    expect(parsePartNumber("1")).toBe(1);
    expect(parsePartNumber("9999")).toBe(9999);
  });

  it("rejects invalid part numbers", () => {
    expect(parsePartNumber(null)).toBeNull();
    expect(parsePartNumber("")).toBeNull();
    expect(parsePartNumber("0")).toBeNull();
    expect(parsePartNumber("1.5")).toBeNull();
    expect(parsePartNumber("abc")).toBeNull();
  });
});

describe("useMultipart", () => {
  it("switches to multipart at 100MB", () => {
    expect(useMultipart(99 * 1024 * 1024)).toBe(false);
    expect(useMultipart(100 * 1024 * 1024)).toBe(true);
    expect(useMultipart(Number.NaN)).toBe(false);
  });
});

describe("positiveInt", () => {
  it("accepts positive numbers and clamps to the max", () => {
    expect(positiveInt("5")).toBe(5);
    expect(positiveInt(3.9)).toBe(3);
    expect(positiveInt(999, 100)).toBe(100);
  });

  it("rejects zero, negatives and non-numeric values", () => {
    expect(positiveInt(0)).toBeNull();
    expect(positiveInt(-5)).toBeNull();
    expect(positiveInt("abc")).toBeNull();
    expect(positiveInt(null)).toBeNull();
  });
});

describe("tryDecode", () => {
  it("decodes valid sequences and rejects malformed input", () => {
    expect(tryDecode("%E4%B8%AD")).toBe("中");
    expect(tryDecode("plain")).toBe("plain");
    expect(tryDecode("%E0%A4%A")).toBeNull();
  });
});

describe("str and asFile", () => {
  it("trims and caps string input", () => {
    expect(str("  hello  ", 10)).toBe("hello");
    expect(str("abcdef", 3)).toBe("abc");
    expect(str(42, 10)).toBe("");
  });

  it("only accepts real File instances", () => {
    expect(asFile("nope")).toBeNull();
    expect(asFile({ name: "a", size: 1, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) })).toBeNull();
    expect(asFile(new File(["abc"], "a.txt", { type: "text/plain" }))).not.toBeNull();
  });
});

/**
 * The strict readers return `null` for the wrong type rather than coercing, so that "field
 * absent" and "field present but wrong type" stay distinguishable at the call site. That
 * distinction is what `updateMetadata`'s `deleteAfterExpiration` check was getting wrong.
 */
describe("bool", () => {
  it("accepts only real booleans", () => {
    expect(bool(true)).toBe(true);
    expect(bool(false)).toBe(false);
    // The string and number forms are what a lenient `if (value)` check would have accepted.
    for (const value of ["true", "false", 1, 0, {}, [], null, undefined]) {
      expect(bool(value), `accepted ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

describe("finiteNumber", () => {
  it("accepts finite numbers and rejects everything else", () => {
    expect(finiteNumber(0)).toBe(0);
    expect(finiteNumber(-1.5)).toBe(-1.5);
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(finiteNumber(value)).toBeNull();
    }
    // Unlike positiveInt, numeric strings are not coerced.
    for (const value of ["30", "", true]) {
      expect(finiteNumber(value), `accepted ${JSON.stringify(value)}`).toBeNull();
    }
  });
});

describe("boundedNumber", () => {
  it("keeps values inside the range and rejects the rest", () => {
    expect(boundedNumber(1, 1, 3650)).toBe(1);
    expect(boundedNumber(3650, 1, 3650)).toBe(3650);
    expect(boundedNumber(0, 1, 3650)).toBeNull();
    expect(boundedNumber(3651, 1, 3650)).toBeNull();
    expect(boundedNumber("30", 1, 3650)).toBeNull();
  });
});

describe("strictPositiveInt", () => {
  it("rejects what the lenient reader would coerce", () => {
    // `Number("30")` is 30, so `positiveInt` takes all of these; a JSON number field that
    // silently accepts a string is the client bug the strict readers exist to report.
    for (const value of ["30", "", null, undefined, true, {}, [], NaN, Infinity]) {
      expect(strictPositiveInt(value), `accepted ${JSON.stringify(value)}`).toBeNull();
    }
  });

  it("rejects a number that is not a whole positive count", () => {
    for (const value of [0, -1, 0.5]) {
      expect(strictPositiveInt(value), `accepted ${value}`).toBeNull();
    }
  });

  it("floors a fraction, so 7.9 days is seven days", () => {
    expect(strictPositiveInt(7.9)).toBe(7);
  });

  it("clamps to the bound instead of rejecting it", () => {
    expect(strictPositiveInt(3650, 3650)).toBe(3650);
    expect(strictPositiveInt(3651, 3650)).toBe(3650);
    expect(strictPositiveInt(9999, 3650)).toBe(3650);
  });

  it("agrees with the lenient reader on every number it takes", () => {
    // The only difference between the two is the coercion, so on numbers they must not diverge —
    // that is what lets the create and update paths answer alike.
    for (const value of [1, 7, 3650, 3651, 9999, 7.9]) {
      expect(strictPositiveInt(value, 3650), `disagreed on ${value}`).toBe(positiveInt(value, 3650));
    }
  });
});

describe("nonEmptyString", () => {
  it("returns the trimmed string or null, never an empty one", () => {
    expect(nonEmptyString("  hello  ", 10)).toBe("hello");
    expect(nonEmptyString("abcdef", 3)).toBe("abc");
    expect(nonEmptyString("   ", 10)).toBeNull();
    expect(nonEmptyString("", 10)).toBeNull();
    expect(nonEmptyString(42, 10)).toBeNull();
  });
});
