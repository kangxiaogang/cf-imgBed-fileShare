import { DetailedError, hc, parseResponse, type ClientResponse } from "hono/client";
import type { AppType } from "../../../worker/src/app";
import { isTransportFailure, NETWORK_MESSAGE, reportError } from "./errors";
import { session } from "./session.svelte";
import { flash } from "./ui.svelte";

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Proves a candidate secret works, before it is stored.
 *
 * The login form used to accept any non-empty string and write it to localStorage, so a
 * misconfigured server and a wrong password were indistinguishable: both produced a file list
 * that failed to load, and nothing on screen said which. This issues one cheap authenticated
 * request with the candidate and lets the caller show the server's own answer.
 *
 * Its own client instance, so the header is the candidate rather than whatever is already in
 * the session — and so a rejected attempt cannot leave a half-valid session behind.
 */
export async function verifySecret(candidate: string): Promise<void> {
  const probe = hc<AppType>("", {
    headers: { Authorization: candidate },
    // Bounded like the main client: probing a secret against a backend that is not running used
    // to hang on the login screen with no way to tell that from a slow server.
    fetch: fetchWithTimeout,
  }) as unknown as Client;
  await request(probe.api.settings.$get());
}

export function handleAuthFailure(status: number) {
  if (status === 401 && session.secret) session.clear();
}

/**
 * `hc` declares each call as returning `ClientResponse<Output, Status, Format>` — an interface
 * wrapping the body stream — because it hands back the raw `Response` and expects
 * `parseResponse` to finish the job. This proxy does that step itself, so the type has to say
 * so: every call resolves to its `Output`.
 *
 * One generic walk over the client's shape. It knows nothing about any particular route, so it
 * stays correct as routes are added — which is the property the hand-written route table
 * lacked.
 */
type ParsedClient<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R extends ClientResponse<infer O, infer _S, infer _F> ? O : R>
    : ParsedClient<T[K]>;
};

type Client = ParsedClient<ReturnType<typeof hc<AppType>>>;

const HTTP_METHODS = new Set(["$get", "$post", "$put", "$delete", "$patch"]);

/**
 * How long a request through this client may take before the page stops waiting for it.
 *
 * Only metadata goes through here — the bytes go out by XHR (`upload.ts`, with its own five
 * minutes) or by a bare `fetch` — so this never has to accommodate a large body. What it does
 * have to accommodate is a server that has stopped answering without closing the connection,
 * which is what a `wrangler dev` whose supervisor was killed looks like from in here: the
 * socket stays open, the request never settles, and the button that was pressed simply never
 * comes back. Nothing above the client could bound that — the promise never rejects.
 */
export const CLIENT_TIMEOUT_MS = 30_000;
export const TIMEOUT_MESSAGE = "请求超时，请重试";

/**
 * The client's `fetch`, with a deadline.
 *
 * Two things it must not break. The caller's own signal still has to work — `pagedList` cancels
 * a superseded page request with one, and a timeout that replaced it would leave those running
 * all the way to the deadline. And the timeout has to be distinguishable from that cancellation,
 * which it would not be if it relied on the `AbortError` `abort()` raises: both arrive as the
 * same `DOMException`, and reporting a deliberate cancellation as a timeout would put a red toast
 * on screen every time the list is paged quickly.
 */
async function fetchWithTimeout(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const deadline = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, CLIENT_TIMEOUT_MS);

  const caller = init?.signal;
  const forward = () => deadline.abort();
  if (caller?.aborted) forward();
  else caller?.addEventListener("abort", forward, { once: true });

  try {
    return await fetch(input, { ...init, signal: deadline.signal });
  } catch (err) {
    if (timedOut) throw new RequestError(TIMEOUT_MESSAGE, 0);
    throw err;
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", forward);
  }
}

/**
 * `hc` resolves the raw `Response`; `parseResponse` is Hono's own step from there to the body,
 * and it throws `DetailedError` on a non-2xx. Re-throwing as `RequestError` keeps the one error
 * type every call site already handles, carrying the server's Chinese message rather than
 * `401 Unauthorized`.
 */
/**
 * The message to show for a failed request.
 *
 * Two body shapes arrive here. The JSON routes answer `{ error }` in Chinese, written for the
 * person reading it, but a platform or gateway response can arrive as `text/plain` — and then the
 * body is the whole message. Reading only `{ error }` threw it away and replaced it with
 * "请求失败 (503)", which turns a self-explanatory failure into a mystery.
 */
function errorText(detail: unknown, status: number): string {
  const data = (detail as { data?: unknown } | undefined)?.data;
  if (typeof data === "string" && data.trim()) return data.trim();
  const fromJson = (data as { error?: string } | undefined)?.error;
  return fromJson || `请求失败 (${status})`;
}

async function request(args: Promise<unknown>): Promise<unknown> {
  try {
    return await parseResponse((await args) as never);
  } catch (err) {
    if (err instanceof DetailedError) {
      const status = err.statusCode;
      handleAuthFailure(status);
      throw new RequestError(errorText(err.detail, status), status);
    }
    // A request that never arrived is not a `DetailedError`, so it used to reach the caller as the
    // browser's own `TypeError` — a different type from every other failure in the app, carrying
    // a message in English. Rewrapped as a `RequestError` so one `catch` shape covers every way a
    // request can fail.
    if (isTransportFailure(err)) throw new RequestError(NETWORK_MESSAGE, 0);
    throw err;
  }
}

/**
 * The typed Hono client for the Worker's own `app`.
 *
 * Every response type comes from the route registration in `apps/worker/src/app.ts`, so an
 * endpoint's shape is written down exactly once: there is no route table to keep in sync and
 * no type argument at a call site. The previous shape, `api.get<T>(path)`, could not do this —
 * `data as T` is unchecked, so a superset type, or a `string` standing in for a `number`,
 * compiled cleanly and only failed in the browser.
 *
 * The proxy exists only to run `parseResponse` behind the call, so that migrating a call site
 * meant changing its path expression and nothing else. `$url` and `$path` need no special
 * case: they are proxied like any other node and calling the proxy reaches Hono's `apply`
 * trap.
 *
 * This does not validate the bytes. A server that disagrees with its own types is caught by
 * the contract tests in `apps/worker/tests/contract.test.ts`, not here.
 */
const wrapped = new WeakMap<object, unknown>();

/**
 * Wraps an `hc` client node so its `$get`-style methods resolve to the parsed body.
 *
 * The wrapping has to recurse. `hc`'s tree is three and four levels deep —
 * `api.api.entry[":id"].$delete` — and a proxy that only rewrites the properties of the node
 * it was handed hands back the sub-object *unwrapped*, so the method one level further down was
 * never routed through `parseResponse`. Every call therefore resolved to a bare `Response`,
 * and every caller read properties off an object that had none: `settings.storeForever` was
 * undefined and the system counters rendered as "undefined". The types said otherwise the
 * whole time, because the client is typed by the route table rather than by what came back.
 *
 * Nothing caught it because every component test replaces this module with a mock, so the one
 * piece of code every request flows through was the one piece with no coverage. See
 * `tests/client.test.ts`.
 */
const wrap = (node: unknown): unknown => {
  if (node === null || (typeof node !== "object" && typeof node !== "function")) return node;
  const cached = wrapped.get(node as object);
  if (cached) return cached;

  const proxy = new Proxy(node as object, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value === "function" && HTTP_METHODS.has(property as string)) {
        // Call the node; do not `value.apply(target, args)`. Every `hc` client node is a
        // `Proxy` over a function whose `get` trap returns another proxy for *any* key
        // except `then` — so reading `apply` off it yields a client node for a path ending
        // in "apply", and calling that builds a request to a URL that does not exist. Only a
        // direct call reaches the proxy's `apply` trap.
        return (...args: unknown[]) =>
          request((value as (...a: unknown[]) => Promise<Response>)(...args));
      }
      return wrap(value);
    },
  });
  wrapped.set(node as object, proxy);
  return proxy;
};

export const api = wrap(
  hc<AppType>("", {
    // Read per request, not captured, so a session set after this module loads still applies.
    headers: () => (session.secret ? { Authorization: session.secret } : ({} as Record<string, string>)),
    fetch: fetchWithTimeout,
  }),
) as unknown as Client;

async function toBlob(path: string, init?: RequestInit): Promise<Blob> {
  const headers = new Headers();
  if (session.secret) headers.set("Authorization", session.secret);
  const res = await fetch(path, { headers, signal: init?.signal });
  if (!res.ok) {
    handleAuthFailure(res.status);
    const text = await res.text();
    let message = `下载失败 (${res.status})`;
    try {
      message = (JSON.parse(text) as { error?: string })?.error || message;
    } catch {
      // keep the default message
    }
    throw new RequestError(message, res.status);
  }
  return res.blob();
}

/**
 * Saves the file. Never rejects: every call site fires and forgets it, so a 404/410/401
 * would otherwise become an unhandled rejection with no user-visible feedback.
 */
export async function download(path: string, filename: string): Promise<void> {
  try {
    const url = URL.createObjectURL(await toBlob(path));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    // Firefox reads the object URL lazily, so revoking too early aborts a large save.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    reportError(err);
  }
}

/**
 * Opens the preview in a new tab. Never rejects, for the same reason as `download`.
 */
export async function openPreview(path: string): Promise<void> {
  // The tab has to be opened synchronously: `await toBlob()` leaves the user-activation
  // window, and a preview necessarily downloads the whole file first, so waiting would
  // lose the race and the popup would be silently blocked.
  const tab = window.open("", "_blank");
  if (!tab) {
    flash.show("浏览器拦截了新窗口，请允许本站弹出窗口", "error");
    return;
  }
  try {
    const url = URL.createObjectURL(await toBlob(path));
    tab.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    tab.close();
    reportError(err);
  }
}

export async function blobUrl(path: string, init?: RequestInit): Promise<string> {
  return URL.createObjectURL(await toBlob(path, init));
}