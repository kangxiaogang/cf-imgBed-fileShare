import type { EntryMutationResponse } from "@picoshare/shared";
import { MULTIPART_CHUNK_SIZE_BYTES } from "@picoshare/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { replaceContent, uploadFiles } from "../src/lib/upload";

const { postInit, postComplete, postAbort } = vi.hoisted(() => ({
  postInit: vi.fn(),
  postComplete: vi.fn(),
  postAbort: vi.fn(),
}));

/**
 * The typed client is a nested proxy, so the mock reproduces the route path. Chunk uploads are
 * the exception: they send a raw binary body that Hono cannot type, so `upload.ts` uses
 * `fetch` directly and `globalThis.fetch` is stubbed instead.
 */
vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      entry: {
        multipart: {
          init: { $post: postInit },
          complete: { $post: postComplete },
          abort: { $post: postAbort },
        },
      },
    },
  },
  RequestError: class RequestError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
    }
  },
}));
vi.mock("../src/lib/session.svelte", () => ({ session: { secret: "test-secret" } }));

const item = (overrides: Partial<EntryMutationResponse> = {}): EntryMutationResponse => ({
  id: "id1",
  filename: "a.txt",
  version: 1,
  sha256: null,
  url: "https://example.com/-id1",
  markdown: "",
  bbcode: "",
  deduped: false,
  ...overrides,
});

class FakeXHR {
  static instances: FakeXHR[] = [];
  upload: { onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } =
    { onprogress: null };
  status = 0;
  responseText = "";
  method = "";
  url = "";
  body: FormData | null = null;
  requestHeaders: Record<string, string> = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.requestHeaders[key] = value;
  }

  send(body?: FormData) {
    this.body = body ?? null;
    FakeXHR.instances.push(this);
    queueMicrotask(() => {
      this.status = 201;
      this.responseText = JSON.stringify(item());
      this.onload?.();
    });
  }
}

beforeEach(() => {
  FakeXHR.instances = [];
  postInit.mockReset();
  postComplete.mockReset();
  postAbort.mockReset();
  vi.stubGlobal("XMLHttpRequest", FakeXHR);
});

describe("uploadFiles", () => {
  it("uploads a small file and pasted text as separate entries", async () => {
    const file = new File(["hello"], "a.txt", { type: "text/plain" });

    const results = await uploadFiles([file], "pasted", { note: "n", expirationDays: 7 });

    expect(results).toHaveLength(2);
    expect(FakeXHR.instances).toHaveLength(2);
    expect(FakeXHR.instances[0].method).toBe("POST");
    expect(FakeXHR.instances[0].url).toBe("/api/entry");
    expect(FakeXHR.instances[0].requestHeaders.Authorization).toBe("test-secret");
    expect(FakeXHR.instances[0].body?.get("note")).toBe("n");
    expect(FakeXHR.instances[0].body?.get("expirationDays")).toBe("7");
    expect(FakeXHR.instances[1].body?.get("pastedText")).toBe("pasted");
    expect(FakeXHR.instances[1].body?.get("file")).toBeNull();
  });

  it("skips the text entry when only metadata is present", async () => {
    const results = await uploadFiles([], "   ", {});

    expect(results).toEqual([]);
    expect(FakeXHR.instances).toHaveLength(0);
  });
});

describe("replaceContent", () => {
  it("uses the small upload endpoint and sends the current version", async () => {
    const file = new File(["hello"], "a.txt", { type: "text/plain" });

    await replaceContent("abc", 3, file);

    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0].method).toBe("PUT");
    expect(FakeXHR.instances[0].url).toBe("/api/entry/abc/content");
    expect(FakeXHR.instances[0].body?.get("version")).toBe("3");
  });

  it("switches to multipart for large files", async () => {
    const file = new File(["hello"], "a.txt", { type: "text/plain" });
    Object.defineProperty(file, "size", { value: 100 * 1024 * 1024, configurable: true });
    postInit.mockResolvedValue({ uploadId: "u1", id: "abc", chunkSize: MULTIPART_CHUNK_SIZE_BYTES });
    postComplete.mockResolvedValue(item());
    const chunkRequests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        chunkRequests.push(String(url));
        return Promise.resolve(new Response("", { status: 200 }));
      }),
    );

    await replaceContent("abc", 2, file);

    expect(postInit).toHaveBeenCalledWith({
      json: expect.objectContaining({ entryId: "abc", version: 2, size: 100 * 1024 * 1024 }),
    });
    expect(chunkRequests).toHaveLength(
      Math.ceil((100 * 1024 * 1024) / MULTIPART_CHUNK_SIZE_BYTES),
    );
    expect(chunkRequests[0]).toMatch(/\/api\/entry\/multipart\/part\/u1\/1$/);
    expect(postComplete).toHaveBeenCalledWith({ json: { uploadId: "u1" } });
    vi.unstubAllGlobals();
    expect(FakeXHR.instances).toHaveLength(0);
  });
});
