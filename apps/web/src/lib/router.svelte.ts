let path = $state(window.location.pathname);
let search = $state(window.location.search);

const onPopState = () => {
  path = window.location.pathname;
  search = window.location.search;
};

window.addEventListener("popstate", onPopState);

// Module scope has no teardown hook, so HMR would stack up a listener per edit. Exporting
// the disposer lets a dev-only cleanup run; production loads the module exactly once.
if (import.meta.hot) {
  import.meta.hot.dispose(() => window.removeEventListener("popstate", onPopState));
}

export const route = {
  get path() {
    return path;
  },
  get segments() {
    return path.split("/").filter(Boolean);
  },
  /** The query string, as a live view. Read it for view state that should survive a reload. */
  get query() {
    return new URLSearchParams(search);
  },
};

export function navigate(to: string) {
  // Resolved against the origin so a relative `to` becomes a comparable absolute pathname
  // plus search. Comparing the raw string would treat "/upload" and "/upload?mode=image" as
  // different every time, including when the second is already current.
  const next = new URL(to, window.location.origin);
  const href = next.pathname + next.search;
  if (href === path + search) return;
  history.pushState({}, "", href);
  path = next.pathname;
  search = next.search;
}

/**
 * `decodeURIComponent` throws a `URIError` on malformed escapes such as `/entry/%E4`, which
 * would abort the render effect and blank the page. The worker has the same guard in
 * `parse.ts` (`tryDecode`).
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
