import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, CLIENT_TIMEOUT_MS, RequestError, TIMEOUT_MESSAGE } from "../src/lib/api";
import { errorMessage, isTransportFailure, NETWORK_MESSAGE } from "../src/lib/errors";
import { session } from "../src/lib/session.svelte";

/**
 * The typed client, exercised for real.
 *
 * Every other test in this suite replaces `../src/lib/api` with a mock of the route tree,
 * which is the right way to test a component and the wrong way to test the client. The result
 * was two bugs nobody could see: the proxy wrapped only one level of `hc`'s tree, and it
 * reached each node with `.apply()`, which Hono's `Proxy`-over-function nodes intercept as a
 * path segment. So every call in the application resolved to something that was not a parsed
 * body, while the types — derived from the route table, not from what came back — said the
 * call had returned a settings object.
 *
 * These tests stub `fetch` and assert on the bytes, so the one module every request flows
 * through finally has coverage of its own.
 */

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };

const calls: Call[] = [];
let respond: () => Response;

const headerBag = (init?: HeadersInit): Record<string, string> => {
  const bag: Record<string, string> = {};
  if (init instanceof Headers) init.forEach((value, key) => void (bag[key] = value));
  else if (init) Object.assign(bag, init as Record<string, string>);
  return bag;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  respond = () => json({});
  // `session` is module state seeded from localStorage at import, so clearing storage alone
  // would leak a secret from one test into the next.
  session.clear();
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method || "GET",
      headers: headerBag(init?.headers),
      body: init?.body,
    });
    return respond();
  }) as unknown as typeof fetch;
});

describe("api", () => {
  it("resolves the parsed body, not a Response", async () => {
    // The whole point of the wrapper. A `Response` has no `entry_count` on it, and the caller
    // is typed as if it did, so nothing downstream would ever notice.
    respond = () =>
      json({ upload_data_bytes: 3, entry_count: 1, guest_link_count: 2, download_count: 4 });

    const info = await api.api["system-info"].$get();

    expect(info).toEqual({
      upload_data_bytes: 3,
      entry_count: 1,
      guest_link_count: 2,
      download_count: 4,
    });
    expect(info).not.toBeInstanceOf(Response);
  });

  it("issues the request the route path names", async () => {
    respond = () => json({ items: [], total: 0 });
    await api.api.entries.$get({ query: { kind: "image" } });
    expect(calls[0].url).toContain("/api/entries");
    expect(calls[0].url).toContain("kind=image");
  });

  it("parses a call nested four levels down", async () => {
    // `api.api.entry[":id"].$delete` is the deepest path the app uses. A wrapper that stops
    // early works everywhere else and fails only here.
    respond = () => json({ ok: true });
    await expect(api.api.entry[":id"].$delete({ param: { id: "abc" } })).resolves.toEqual({
      ok: true,
    });
    expect(calls[0].url).toContain("/api/entry/abc");
    expect(calls[0].method).toBe("DELETE");
  });

  it("substitutes a path parameter and appends a query", async () => {
    respond = () => json({ total: 0, events: [] });
    await api.api.entry[":id"].downloads.$get({ param: { id: "xyz" }, query: { uniqueIps: "1" } });
    expect(calls[0].url).toContain("xyz");
    expect(calls[0].url).toContain("uniqueIps=1");
  });

  it("sends a JSON body with the right content type", async () => {
    respond = () => json({ ok: true, filename: "a.png" });
    await api.api.settings.$put({ json: { storeForever: true, defaultDays: 7 } });
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(calls[0].body as string)).toEqual({
      storeForever: true,
      defaultDays: 7,
    });
  });

  it("sends the session secret as a header", async () => {
    session.set("s3cret");
    await api.api.settings.$get();
    expect(calls[0].headers.Authorization).toBe("s3cret");
  });

  it("reads the session per request rather than capturing it at import time", async () => {
    // A client built before the user logs in would otherwise send no header at all until a
    // full reload, which presents as "the login button does nothing".
    await api.api.settings.$get();
    expect(calls[0].headers.Authorization).toBeUndefined();

    session.set("later");
    await api.api.settings.$get();
    expect(calls[1].headers.Authorization).toBe("later");
  });

  it("turns a server error into a RequestError carrying the server's message", async () => {
    respond = () => json({ error: "该访客链接的上传次数已达上限" }, 429);

    const err = await api.api.settings.$get().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as InstanceType<typeof RequestError>).status).toBe(429);
    // The Chinese text, not "429" — the server wrote it for the person reading it.
    expect((err as Error).message).toBe("该访客链接的上传次数已达上限");
  });

  it("shows a plain-text body from an upstream failure", async () => {
    // Not JSON, and not something this app wrote — but a body that says what went wrong beats
    // "502", so it is surfaced rather than discarded.
    respond = () => new Response("upstream exploded", { status: 502 });

    const err = await api.api.settings.$get().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as InstanceType<typeof RequestError>).status).toBe(502);
    expect((err as Error).message).toBe("upstream exploded");
  });

  it("clears the session on a 401", async () => {
    // A stored secret that has been rotated is worse than no secret: every request fails and
    // the UI has no way to tell the user why.
    session.set("stale");
    respond = () => json({ error: "未授权，请检查访问密钥" }, 401);

    await api.api.settings.$get().catch(() => {});

    expect(session.authed).toBe(false);
  });

  it("shows a text error body verbatim", async () => {
    // Not every error comes from our own JSON routes: a platform or gateway response can arrive
    // as `text/plain`, and its body is the only thing that says what happened. Reading only
    // `{ error }` would replace it with "请求失败 (503)".
    respond = () =>
      new Response("PS_SHARED_SECRET 未配置或仍是示例值。", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });

    const err = await api.api.settings.$get().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect((err as InstanceType<typeof RequestError>).status).toBe(503);
    expect((err as Error).message).toBe("PS_SHARED_SECRET 未配置或仍是示例值。");
  });

  it("still prefers the JSON error field when there is one", async () => {
    respond = () => json({ error: "文件已过期" }, 410);
    const err = await api.api.settings.$get().catch((e: unknown) => e);
    expect((err as Error).message).toBe("文件已过期");
  });

  it("falls back to the status when the body says nothing useful", async () => {
    respond = () => new Response("   ", { status: 502, headers: { "Content-Type": "text/plain" } });
    const err = await api.api.settings.$get().catch((e: unknown) => e);
    expect((err as Error).message).toContain("502");
  });

  it("verifies a candidate secret with the candidate, not the stored one", async () => {
    // This is what the login form calls before storing anything. Using the session's header
    // would either check the wrong secret or check nothing on a first visit.
    const { verifySecret } = await import("../src/lib/api");
    session.set("already-stored");

    await verifySecret("candidate");

    expect(calls[0].headers.Authorization).toBe("candidate");
  });

  it("does not let a failed verification touch the session", async () => {
    const { verifySecret } = await import("../src/lib/api");
    session.set("already-stored");
    respond = () => json({ error: "未授权，请检查访问密钥" }, 401);

    await expect(verifySecret("wrong")).rejects.toThrow("未授权，请检查访问密钥");

    // handleAuthFailure clears on 401 regardless, which is the intended behaviour for a
    // rotated secret; what matters is that nothing was stored.
    expect(session.secret).toBe("");
  });

  it("lets a non-DetailedError through unchanged", async () => {
    // An aborted download is a `DOMException`, and `reportError` checks for that by name.
    // Rewrapping it would lose the distinction.
    respond = () => {
      throw new DOMException("aborted", "AbortError");
    };

    const err = await api.api.settings.$get().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
  });
});

/**
 * A server that has stopped answering fails in two distinguishable ways, and until now the app
 * handled neither.
 *
 * The first is a connection that is refused: `fetch` rejects with a `TypeError` carrying
 * whatever the browser happens to call it, and that string reached the screen unchanged — an
 * English sentence from the browser, in an interface that is otherwise entirely Chinese, shown at
 * the moment the reader most needs to understand it.
 *
 * The second is worse, because nothing happens at all. A `wrangler dev` whose supervisor was
 * killed keeps its socket open and never completes the request, so the promise never settles: no
 * error, no toast, and a button that looks pressed forever. That state was reached by accident
 * while working on this, which is the only reason it is written down.
 */
describe("a request that never reaches a server", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** What a browser throws when the origin is not there. */
  const refuse = (message = "Failed to fetch") => () => {
    throw new TypeError(message);
  };

/** What a real `fetch` does when its signal aborts: rejects. A stub that ignores the signal cannot show whether anything cancelled anything. */
const neverAnswers = (signal?: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    // Already aborted is a rejection, not a wait: a listener added to a fired signal never runs,
    // so a stub that only listened would hang where the browser would not.
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

  it("reaches the caller as a RequestError, not as a raw TypeError", async () => {
    // Every other failure in the app is a `RequestError`, and every `catch` is written on that
    // assumption. A transport failure arriving as a `TypeError` is the one case where a caller
    // inspecting the type would be wrong.
    globalThis.fetch = vi.fn(refuse()) as unknown as typeof fetch;

    const err = await api.api.settings.$get().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RequestError);
    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe(NETWORK_MESSAGE);
  });

  it("recognises each browser's own wording for it", () => {
    // Chromium, Safari, Node. All one condition, and all equally meaningless to a reader.
    for (const message of [
      "Failed to fetch",
      "Load failed",
      "NetworkError when attempting to fetch resource.",
      "fetch failed",
    ]) {
      expect(isTransportFailure(new TypeError(message)), message).toBe(true);
    }
    // A `TypeError` from a bug is not a network problem, and saying "cannot reach the server"
    // about one would send the reader in the wrong direction.
    expect(isTransportFailure(new TypeError("x.map is not a function"))).toBe(false);
  });

  it("says the same thing on the paths that never use this client", () => {
    // A download and a preview go out through a bare `fetch`, so they throw the browser's
    // `TypeError` unchanged and never see the rewrapping above. `errorMessage` is the one
    // funnel every call site uses, which is what makes this hold for all of them.
    expect(errorMessage(new TypeError("Failed to fetch"))).toBe(NETWORK_MESSAGE);
  });

  it("gives up on a request that never comes back", async () => {
    // The promise never settling is the whole problem: there is no rejection for a `catch` to
    // handle and no response for a status to be read from, so nothing above this could ever
    // recover on its own.
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      neverAnswers(init?.signal),
    ) as unknown as typeof fetch;

    const pending = api.api.settings.$get();
    const assertion = expect(pending).rejects.toThrow(TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);
    await assertion;
  });

  it("still honours a cancellation the caller asked for", async () => {
    // `pagedList` aborts a page request that has been superseded. A timeout that swallowed the
    // caller's signal would leave those running to the deadline, and reporting them as timeouts
    // would put a red toast on screen every time the list is paged quickly.
    vi.useFakeTimers();
    const controller = new AbortController();
    globalThis.fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      neverAnswers(init?.signal),
    ) as unknown as typeof fetch;

    // `init`, not a bare `signal`. The client builds its `fetch` init from `opt.init` and
    // nothing else, so a signal passed beside the query is read by nobody and silently dropped —
    // which is how `pagedList` came to believe it was cancelling the page requests it supersedes.
    const pending = api.api.entries.$get({}, { init: { signal: controller.signal } }).catch(
      (e: unknown) => e,
    );
    // After the request is under way, not before: the client awaits its header function before
    // calling `fetch`, so an abort issued synchronously would land before anything was sent.
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await vi.advanceTimersByTimeAsync(CLIENT_TIMEOUT_MS);
    const err = await pending;

    // The caller's own error, not the timeout — the two are otherwise indistinguishable, since
    // `abort()` raises the same `DOMException` either way.
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect((err as Error).message).not.toBe(TIMEOUT_MESSAGE);
  });

  it("does not leave the deadline running once a request has answered", async () => {
    // A timer left armed would keep firing against a page that has moved on.
    vi.useFakeTimers();
    respond = () => json({ storeForever: true, defaultDays: 14 });

    await api.api.settings.$get();

    expect(vi.getTimerCount()).toBe(0);
  });
});
