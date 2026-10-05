import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The router tracks pathname and search separately, which is what lets a view put state in
 * the URL. It also fixed a latent bug: `navigate` compared the raw string against the
 * pathname, so navigating to the current path with a different query always pushed a history
 * entry it could not tell apart from the current one.
 *
 * `history` is spied on rather than replaced — the module also calls `replaceState` and the
 * test needs the real one to move the location.
 */
let pushState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  pushState = vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("navigate", () => {
  it("records a query string without letting it into the path", async () => {
    const { navigate, route } = await import("../src/lib/router.svelte");

    navigate("/upload?mode=image");

    // The path is what routing matches on, so a query must not end up inside a segment.
    expect(route.path).toBe("/upload");
    expect(route.segments).toEqual(["upload"]);
    expect(route.query.get("mode")).toBe("image");
    expect(pushState).toHaveBeenCalledWith({}, "", "/upload?mode=image");
  });

  it("does not push an entry for the location it is already at", async () => {
    const { navigate, route } = await import("../src/lib/router.svelte");
    navigate("/upload");
    pushState.mockClear();

    navigate("/upload");

    expect(pushState).not.toHaveBeenCalled();
    expect(route.query.get("mode")).toBeNull();
  });

  it("treats a different query as a different location", async () => {
    const { navigate, route } = await import("../src/lib/router.svelte");
    navigate("/upload?mode=image");
    pushState.mockClear();

    navigate("/upload");

    expect(pushState).toHaveBeenCalledWith({}, "", "/upload");
    expect(route.query.get("mode")).toBeNull();
  });

  it("keeps the path usable for routing when the query changes", async () => {
    const { navigate, route } = await import("../src/lib/router.svelte");

    navigate("/upload?mode=image");
    expect(route.segments).toEqual(["upload"]);

    navigate(`/entry/${encodeURIComponent("a b")}`);
    expect(route.path).toBe("/entry/a%20b");
    expect(route.segments).toEqual(["entry", "a%20b"]);
  });

  it("reads the query after a back navigation", async () => {
    const { navigate, route } = await import("../src/lib/router.svelte");
    navigate("/upload?mode=image");

    // What popstate does: the browser has moved the location and the module re-reads it. This
    // is the case a local `$state` for the tab could not handle.
    window.history.replaceState({}, "", "/upload");
    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(route.path).toBe("/upload");
    expect(route.query.get("mode")).toBeNull();
  });
});
