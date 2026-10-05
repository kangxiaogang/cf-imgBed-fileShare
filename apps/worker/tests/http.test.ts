import { describe, expect, it, vi } from "vitest";
import {
  MAX_JSON_BYTES,
  HttpError,
  assertBodyWithinLimit,
  declaredBodySize,
  handleError,
  rateLimit,
  readBodyWithinLimit,
  readJson,
} from "../src/platform/http";
import { positiveInt } from "../src/platform/parse";

const sized = (contentLength: string | null, body = ""): Request =>
  new Request("https://x/api/x", {
    method: "POST",
    body,
    headers: contentLength === null ? {} : { "Content-Length": contentLength },
  });

describe("declaredBodySize", () => {
  it("reads the declared length", () => {
    expect(declaredBodySize(sized("1234"))).toBe(1234);
  });

  it("reports 0 when the header is missing or unusable", () => {
    expect(declaredBodySize(sized(null))).toBe(0);
    expect(declaredBodySize(sized("not-a-number"))).toBe(0);
    expect(declaredBodySize(sized("-5"))).toBe(0);
  });
});

describe("assertBodyWithinLimit", () => {
  it("passes a body at the limit", () => {
    expect(() => assertBodyWithinLimit(sized("100"), 100, "too big")).not.toThrow();
  });

  it("throws 413 above the limit", () => {
    const err = (() => {
      try {
        assertBodyWithinLimit(sized("101"), 100, "too big");
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
    expect((err as HttpError).message).toBe("too big");
  });

  it("does not throw when the size is unknown", () => {
    expect(() => assertBodyWithinLimit(sized(null), 100, "too big")).not.toThrow();
  });
});

describe("readBodyWithinLimit", () => {
  it("buffers a body under the cap", async () => {
    const request = new Request("https://x/api/x", { method: "POST", body: "hello" });
    const buf = await readBodyWithinLimit(request, 100, "too big");
    expect(new TextDecoder().decode(buf)).toBe("hello");
  });

  it("stops at the cap even when no Content-Length was sent", async () => {
    // The path this protects: a chunked body, where `assertBodyWithinLimit` sees 0 and would
    // let `arrayBuffer()` allocate the whole thing inside the isolate.
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(30));
        controller.close();
      },
    });
    const request = new Request("https://x/api/x", {
      method: "POST",
      body: stream,
      duplex: "half",
    } as RequestInit);
    const err = await readBodyWithinLimit(request, 100, "too big").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });
});

describe("rateLimit", () => {
  it("counts up to the limit then refuses", () => {
    const key = `t-${Math.random()}`;
    expect(rateLimit(key, 2, 1000)).toBe(true);
    expect(rateLimit(key, 2, 1000)).toBe(true);
    expect(rateLimit(key, 2, 1000)).toBe(false);
  });

  it("does not free every bucket when the map is full", () => {
    // Filling the table used to call `clear()`, which wiped the counters an attacker had
    // just tripped — the limit it was protecting stopped applying on demand. A burst of
    // expired buckets must be evicted without touching the live one.
    const live = `live-${Math.random()}`;
    expect(rateLimit(live, 1, 60_000)).toBe(true);
    expect(rateLimit(live, 1, 60_000)).toBe(false);
    for (let i = 0; i < 1_500; i += 1) rateLimit(`bulk-${i}`, 5, 0);
    expect(rateLimit(live, 1, 60_000)).toBe(false);
  });
});

describe("readJson", () => {
  it("parses a JSON body", async () => {
    const request = new Request("https://x/api/x", { method: "POST", body: '{"a":1}' });
    await expect(readJson<{ a: number }>(request)).resolves.toEqual({ a: 1 });
  });

  it("throws 400 for a malformed body", async () => {
    const request = new Request("https://x/api/x", { method: "POST", body: "{oops" });
    const err = await readJson(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(400);
  });

  it("throws 413 for an oversized body", async () => {
    // A 100MB JSON body on /api/entries/delete would otherwise be parsed in full.
    const request = new Request("https://x/api/x", {
      method: "POST",
      body: JSON.stringify({ ids: new Array(200_000).fill("a") }),
    });
    const err = await readJson(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(413);
  });

  it("keeps MAX_JSON_BYTES small", () => {
    expect(MAX_JSON_BYTES).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("handleError", () => {
  it("keeps the status and message of an HttpError", async () => {
    const res = handleError(new HttpError(404, "文件不存在"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "文件不存在" });
  });

  it("reports an internal TypeError as a 500, not a 400", async () => {
    // Reporting a genuine bug as "请求体格式错误" both misled the caller and hid the failure,
    // because only the 500 branch logged anything.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = handleError(new TypeError("cannot read properties of undefined"));
    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("logs an unknown throw", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(handleError(new Error("boom")).status).toBe(500);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("positiveInt", () => {
  it("returns a positive integer", () => {
    expect(positiveInt(5)).toBe(5);
    expect(positiveInt("7")).toBe(7);
  });

  it("clamps to max", () => {
    expect(positiveInt(100, 10)).toBe(10);
  });

  it("never returns 0 for a fractional input", () => {
    // Callers gate caps on truthiness, so 0 would silently disable the cap.
    expect(positiveInt(0.5)).toBeNull();
    expect(positiveInt(0.999)).toBeNull();
    expect(positiveInt(1e-9)).toBeNull();
  });

  it("returns null for non-positive or non-numeric input", () => {
    expect(positiveInt(0)).toBeNull();
    expect(positiveInt(-5)).toBeNull();
    expect(positiveInt("abc")).toBeNull();
    expect(positiveInt(null)).toBeNull();
    expect(positiveInt(undefined)).toBeNull();
  });
});

describe("handleError", () => {
  it("names the cause when the database is behind the code", async () => {
    // A stale schema fails as `no such column`, which is indistinguishable from any other bug
    // once it becomes a 500 — and it is the one failure with a two-second fix. Observed exactly
    // this way: images stopped previewing, every read path returned 500, and nothing in the
    // response connected it to a renamed column.
    const res = handleError(new Error("D1_ERROR: no such column: entries.object_key"));

    expect(res.status).toBe(500);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("数据库结构与代码不匹配");
    expect(body).toContain("d1:init");
    expect(body).toContain("重建");
  });

  it("still reports an ordinary bug as an ordinary 500", async () => {
    const res = handleError(new TypeError("x is not a function"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });
});
