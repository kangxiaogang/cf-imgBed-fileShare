import { flash } from "./ui.svelte";

/**
 * What the browser says when a request never reached a server at all: the origin is down, DNS
 * failed, CORS refused it, or the machine is offline.
 *
 * Chromium says "Failed to fetch", Safari "Load failed", Firefox "NetworkError when attempting to
 * fetch resource". None of them mean anything to the person reading them — and every one of them
 * means exactly the same thing here: nothing answered. They were reaching the screen unchanged,
 * so a backend that had stopped was reported in English inside an otherwise Chinese interface,
 * at the moment the message mattered most.
 */
const TRANSPORT_FAILURE =
  /failed to fetch|load failed|networkerror|network request failed|fetch failed/i;

/** Said instead, because it is the part the reader can act on. */
export const NETWORK_MESSAGE = "无法连接服务器，请确认后台已启动";

/**
 * Whether a thrown value is that failure, rather than a mistake in the code that called.
 *
 * `fetch` rejects with a `TypeError` for it, so the type alone does not say so — the message
 * does. Checked here as well as at the call site because the two request paths behave
 * differently: the typed client can rewrap the rejection as a `RequestError` before anybody sees
 * it, while a download or a preview goes out through a bare `fetch` and throws it unchanged.
 */
export const isTransportFailure = (err: unknown): boolean =>
  err instanceof TypeError && TRANSPORT_FAILURE.test(err.message);

/**
 * Normalises anything thrown into a displayable message. The API client rejects with
 * `RequestError` (an `Error`), but `catch` blocks also see `unknown` from DOM APIs.
 *
 * Every call site funnels through here, so this is the one place that has to recognise a
 * transport failure — including the ones that never pass through the typed client.
 */
export const errorMessage = (err: unknown): string => {
  if (isTransportFailure(err)) return NETWORK_MESSAGE;
  return err instanceof Error ? err.message : String(err);
};

export const isAbort = (err: unknown): boolean =>
  err instanceof DOMException && err.name === "AbortError";

/** Report a failed side-effect request (download, preview) that no caller awaits. */
export const reportError = (err: unknown): void => {
  if (isAbort(err)) return;
  flash.show(errorMessage(err), "error");
};