import type { EntryListItem } from "@picoshare/shared";
import { DEFAULT_PAGE_SIZE } from "@picoshare/shared";
import { api } from "./api";
import { errorMessage, isAbort } from "./errors";
import { flash } from "./ui.svelte";

export type PagedListOptions = {
  kind?: "all" | "image";
  pageSize?: number;
};

export function pagedList(options: PagedListOptions = {}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  let items = $state<EntryListItem[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state("");
  let exhausted = $state(false);
  let search = $state("");
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  // Two loads can overlap (the initial load and the debounced search load), so responses
  // must be able to tell whether they are still the newest one.
  let requestSeq = 0;
  let controller: AbortController | undefined;

  const hasMore = $derived(!exhausted && items.length < total);
  const loadedBytes = $derived(items.reduce((sum, entry) => sum + (entry.size || 0), 0));

  async function load(reset: boolean): Promise<void> {
    if (!reset && loadingMore) return;
    if (reset) loading = true;
    else loadingMore = true;
    error = "";

    const seq = ++requestSeq;
    const active = new AbortController();
    controller?.abort();
    controller = active;
    try {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(reset ? 0 : items.length),
      });
      if (options.kind === "image") params.set("kind", "image");
      if (search) params.set("q", search);
      const page = await api.api.entries.$get(
        { query: Object.fromEntries(params) },
        // Under `init`, because that is the only part of a call's options the client copies into
        // its `fetch`. Beside the query it looked right and was read by nobody, so this abort
        // never happened: a superseded page ran to completion and was then discarded by the
        // sequence check below. The check was doing the work on its own, which is why nothing
        // looked wrong.
        { init: { signal: active.signal } },
      );
      if (seq !== requestSeq) return;
      if (reset) {
        items = page.items;
        exhausted = false;
      } else {
        // The server pages by OFFSET, so a row inserted between two requests shifts the
        // window and the next page repeats rows already on screen. A keyed each block
        // throws on duplicates, which would take down the whole list view.
        const seen = new Set(items.map((item) => item.id));
        const fresh = page.items.filter((item) => !seen.has(item.id));
        items = [...items, ...fresh];
        // A short page means the end was reached; without this `hasMore` stays true and
        // every "load more" re-requests the same offset forever.
        if (fresh.length === 0) exhausted = true;
      }
      total = page.total;
    } catch (err) {
      if (isAbort(err) || seq !== requestSeq) return;
      error = errorMessage(err);
      flash.show(error, "error");
    } finally {
      if (seq === requestSeq) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  function onSearch(query: string) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      search = query.trim();
      void load(true);
    }, 300);
  }

  function removeLocal(ids: string[]) {
    const removed = new Set(ids);
    const before = items.length;
    items = items.filter((item) => !removed.has(item.id));
    total = Math.max(0, total - (before - items.length));
  }

  function dispose() {
    clearTimeout(searchTimer);
    requestSeq += 1;
    controller?.abort();
  }

  return {
    get items() {
      return items;
    },
    get total() {
      return total;
    },
    get loading() {
      return loading;
    },
    get loadingMore() {
      return loadingMore;
    },
    get error() {
      return error;
    },
    get hasMore() {
      return hasMore;
    },
    get loadedBytes() {
      return loadedBytes;
    },
    load,
    onSearch,
    removeLocal,
    dispose,
  };
}
