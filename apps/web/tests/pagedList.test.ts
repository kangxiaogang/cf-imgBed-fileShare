import { beforeEach, describe, expect, it, vi } from "vitest";
import { pagedList } from "../src/lib/pagedList.svelte";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));

/** The typed client is a nested proxy, so the mock has to reproduce `api.api.entries.$get`. */
vi.mock("../src/lib/api", () => ({ api: { api: { entries: { $get: get } } } }));
vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

const entry = (id: string) => ({ id, filename: `${id}.png` });

/**
 * Two arguments: the paging window, and the request options carrying the AbortSignal that
 * cancels a superseded request.
 *
 * They were one argument, with the signal beside the query — where it looked right and was read
 * by nobody, because the client builds its `fetch` init from `options.init` and nothing else.
 * Nothing noticed, because the sequence check in `pagedList` discards the stale response anyway,
 * so a cancellation that never happened looked identical to one that had.
 *
 * Asserted as a pair because the distinction is invisible from the types: a signal outside `init`
 * is not a signal.
 */
const called = (fields: Record<string, string>) => [
  expect.objectContaining({ query: expect.objectContaining(fields) }),
  expect.objectContaining({ init: expect.objectContaining({ signal: expect.any(AbortSignal) }) }),
];

beforeEach(() => {
  get.mockReset();
});

describe("pagedList", () => {
  it("loads the first page with the image filter", async () => {
    get.mockResolvedValue({ items: [entry("a")], total: 3 });
    const list = pagedList({ kind: "image" });

    await list.load(true);

    expect(get).toHaveBeenCalledWith(...called({ kind: "image", offset: "0" }));
    expect(list.items.map((item) => item.id)).toEqual(["a"]);
    expect(list.total).toBe(3);
    expect(list.hasMore).toBe(true);
    expect(list.loading).toBe(false);
  });

  it("appends the next page using the current item count as offset", async () => {
    get
      .mockResolvedValueOnce({ items: [entry("a"), entry("b")], total: 3 })
      .mockResolvedValueOnce({ items: [entry("c")], total: 3 });
    const list = pagedList();

    await list.load(true);
    await list.load(false);

    expect(get).toHaveBeenLastCalledWith(...called({ offset: "2" }));
    expect(list.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(list.hasMore).toBe(false);
  });

  it("debounces search input", async () => {
    vi.useFakeTimers();
    try {
      get.mockResolvedValue({ items: [], total: 0 });
      const list = pagedList();
      await list.load(true);
      get.mockClear();

      list.onSearch("photo");
      await vi.advanceTimersByTimeAsync(299);
      expect(get).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(get).toHaveBeenCalledWith(...called({ q: "photo" }));
      list.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes deleted items and adjusts the total", async () => {
    get.mockResolvedValue({ items: [entry("a"), entry("b")], total: 5 });
    const list = pagedList();
    await list.load(true);

    list.removeLocal(["a"]);

    expect(list.items.map((item) => item.id)).toEqual(["b"]);
    expect(list.total).toBe(4);
  });

  it("surfaces load failures through the flash message and the error state", async () => {
    const { flash } = await import("../src/lib/ui.svelte");
    get.mockRejectedValue(new Error("boom"));
    const list = pagedList();

    await list.load(true);

    expect(flash.show).toHaveBeenCalledWith("boom", "error");
    expect(list.error).toBe("boom");
    expect(list.loading).toBe(false);
  });

  it("does not append rows the shifted page already returned", async () => {
    // A row uploaded between the two requests shifts the OFFSET window, so page 2 repeats
    // the last row of page 1. A keyed each block throws on duplicates, taking down the view.
    get
      .mockResolvedValueOnce({ items: [entry("a"), entry("b")], total: 4 })
      .mockResolvedValueOnce({ items: [entry("b"), entry("c")], total: 4 });
    const list = pagedList();

    await list.load(true);
    await list.load(false);

    expect(list.items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("stops offering more pages once a page adds nothing new", async () => {
    // Otherwise hasMore stays true and every click re-requests the same offset forever.
    get
      .mockResolvedValueOnce({ items: [entry("a")], total: 9 })
      .mockResolvedValueOnce({ items: [entry("a")], total: 9 });
    const list = pagedList();

    await list.load(true);
    expect(list.hasMore).toBe(true);

    await list.load(false);

    expect(list.hasMore).toBe(false);
  });

  it("lets the newest response win when two loads overlap", async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    get
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce({ items: [entry("new")], total: 1 });
    const list = pagedList();

    const first = list.load(true);
    const second = list.load(true);
    await second;
    // The stale, slower response must not overwrite the newer state.
    resolveFirst({ items: [entry("old")], total: 1 });
    await first;

    expect(list.items.map((item) => item.id)).toEqual(["new"]);
    expect(list.loading).toBe(false);
  });

  it("ignores an aborted load", async () => {
    const { flash } = await import("../src/lib/ui.svelte");
    get.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const list = pagedList();

    await list.load(true);

    expect(flash.show).not.toHaveBeenCalled();
    expect(list.error).toBe("");
    expect(list.loading).toBe(false);
  });
});
