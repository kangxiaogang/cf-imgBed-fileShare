import { describe, expect, it } from "vitest";
import { isInlineSafe, isImageContentType } from "@picoshare/shared";
import { applyContentHeaders, cacheControlFor, disposition } from "../src/platform/serve";

describe("isInlineSafe", () => {
  it("allows common media and document types", () => {
    for (const ct of ["image/png", "image/jpeg", "image/webp", "video/mp4", "audio/mpeg", "application/pdf", "text/plain"]) {
      expect(isInlineSafe(ct)).toBe(true);
    }
  });

  it("forces dangerous types to attachment", () => {
    for (const ct of ["text/html", "application/xhtml+xml", "image/svg+xml", "application/javascript", "text/javascript", "application/xml", ""]) {
      expect(isInlineSafe(ct)).toBe(false);
    }
  });

  it("ignores parameters and case", () => {
    expect(isInlineSafe("TEXT/HTML; charset=utf-8")).toBe(false);
    expect(isInlineSafe("Image/PNG")).toBe(true);
  });
});

describe("disposition", () => {
  it("builds an inline header with a utf-8 filename", () => {
    expect(disposition("inline", "照片.png")).toBe(
      "inline; filename=\"__.png\"; filename*=UTF-8''%E7%85%A7%E7%89%87.png",
    );
  });

  it("builds attachment headers", () => {
    expect(disposition("attachment", "a.html")).toMatch(/^attachment; filename="a\.html"/);
    expect(disposition("attachment", "a.png")).toMatch(/^attachment; /);
  });
});

describe("cacheControlFor", () => {
  it("caches images and revalidates others", () => {
    expect(cacheControlFor("image/png")).toBe("public, max-age=86400");
    expect(cacheControlFor("text/plain")).toBe("no-cache, must-revalidate");
    expect(cacheControlFor(null)).toBe("no-cache, must-revalidate");
  });
});

describe("applyContentHeaders", () => {
  it("sets disposition, cache, nosniff and svg csp", () => {
    const png = new Headers();
    applyContentHeaders(png, "image/png", "a.png");
    expect(png.get("X-Content-Type-Options")).toBe("nosniff");
    expect(png.get("Content-Disposition")).toMatch(/^inline; /);
    expect(png.get("Cache-Control")).toBe("public, max-age=86400");
    expect(png.get("Content-Security-Policy")).toBeNull();

    const svg = new Headers();
    applyContentHeaders(svg, "image/svg+xml", "a.svg");
    expect(svg.get("Content-Disposition")).toMatch(/^attachment; /);
    expect(svg.get("Content-Security-Policy")).toContain("sandbox");
    expect(svg.get("X-Content-Type-Options")).toBe("nosniff");
  });
});

describe("isImageContentType", () => {
  it("detects image types", () => {
    expect(isImageContentType("image/png")).toBe(true);
    expect(isImageContentType("image/svg+xml")).toBe(true);
    expect(isImageContentType("application/pdf")).toBe(false);
  });
});
