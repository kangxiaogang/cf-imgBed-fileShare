import { blobUrl } from "./api";

export type PreviewState = {
  readonly url: string;
  readonly loading: boolean;
  readonly failed: boolean;
};

/**
 * Fetches an authenticated blob URL and revokes it on teardown.
 *
 * `path` and `enabled` are passed as getters on purpose: a `$derived`/`$state` value handed
 * over as a plain argument would be captured once, never tracked, so the URL would not
 * refresh when the entry changes. Reading them inside the effect makes them dependencies.
 *
 * The revoke has to happen from whichever side finishes last: capturing the URL in a
 * `let revoked = ""` and revoking only in the cleanup means an unmount before the request
 * resolves leaks the whole blob into the page's memory for the rest of the session.
 * `disposed` covers that ordering, and `created` covers a URL that arrives after teardown.
 */
export function previewUrl(path: () => string, enabled: () => boolean = () => true): PreviewState {
  let url = $state("");
  let loading = $state(true);
  let failed = $state(false);

  $effect(() => {
    const source = path();
    if (!enabled()) {
      loading = false;
      return;
    }
    let disposed = false;
    let created = "";
    loading = true;
    failed = false;
    url = "";
    void blobUrl(source)
      .then((value) => {
        created = value;
        if (disposed) URL.revokeObjectURL(value);
        else url = value;
      })
      .catch(() => {
        if (!disposed) failed = true;
      })
      .finally(() => {
        if (!disposed) loading = false;
      });
    return () => {
      disposed = true;
      if (created) URL.revokeObjectURL(created);
      url = "";
    };
  });

  return {
    get url() {
      return url;
    },
    get loading() {
      return loading;
    },
    get failed() {
      return failed;
    },
  };
}
