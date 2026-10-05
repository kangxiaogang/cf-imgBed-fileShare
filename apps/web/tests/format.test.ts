import { describe, expect, it } from "vitest";
import { bbcodeImage, htmlImage, markdownImage } from "@picoshare/shared";
import {
  formatBytes,
  formatDate,
  guestUrl,
  imageLink,
  shortLink,
} from "../src/lib/format";

describe("formatBytes", () => {
  it("formats byte sizes across units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
  });

  it("returns a placeholder for invalid values", () => {
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });

  it("does not round up into the next unit", () => {
    // 1048575 bytes is 1023.999 KB, which toFixed(0) rendered as "1024 KB".
    expect(formatBytes(1024 * 1024 - 1)).toBe("1.0 MB");
  });
});

describe("formatDate", () => {
  it("returns a placeholder for empty values", () => {
    expect(formatDate(null)).toBe("-");
    expect(formatDate(undefined)).toBe("-");
    expect(formatDate("")).toBe("-");
  });

  it("returns the raw value when unparsable", () => {
    expect(formatDate("not-a-date")).toBe("not-a-date");
  });

  it("formats ISO timestamps", () => {
    // The zh-CN locale renders unpadded parts, so match the shape rather than the digits.
    expect(formatDate("2026-01-02T03:04:05.000Z")).toMatch(/^\d{4}\/\d{1,2}\/\d{1,2}\s/);
  });
});

describe("link builders", () => {
  it("builds absolute short and image links", () => {
    expect(shortLink("abc")).toBe(`${window.location.origin}/-abc`);
    expect(imageLink("abc", "照片.png")).toBe(
      `${window.location.origin}/img/abc/%E7%85%A7%E7%89%87.png`,
    );
    expect(guestUrl("g1")).toBe(`${window.location.origin}/guest/g1`);
  });

  it("escapes markdown, html and bbcode fragments", () => {
    expect(markdownImage("https://x/y.png", "a]b")).toBe("![a\\]b](https://x/y.png)");
    expect(htmlImage("https://x/y.png", 'a&"b')).toBe('<img src="https://x/y.png" alt="a&amp;&quot;b" />');
    expect(bbcodeImage("https://x/y.png")).toBe("[img]https://x/y.png[/img]");
  });
});
