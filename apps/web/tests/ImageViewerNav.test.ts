import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { blobUrl, getEntries } = vi.hoisted(() => ({ blobUrl: vi.fn(), getEntries: vi.fn() }));

vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      entries: { $get: getEntries },
      entry: { ":id": { downloads: { $get: vi.fn().mockResolvedValue({ total: 0, events: [] }) } } },
    },
  },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl,
}));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: vi.fn(), hide: vi.fn(), value: null },
  confirmAction: vi.fn().mockResolvedValue(true),
}));

/**
 * 详情 in the lightbox: it closed the lightbox and left the gallery on screen.
 *
 * Not a routing mistake. `onClose()` clears the parent's `lightbox`, a `$state` write propagates
 * synchronously, and the next statement read an `entry` that was already `null` — so `navigate`
 * was handed `undefined` and threw. The button's whole visible effect was the close, which read
 * as "it went back to the gallery" rather than as an error.
 *
 * Both other tests of this component replace the router with a spy, so neither could see a
 * navigation that did not happen; the assertions here are on `location.pathname` instead. The
 * lightbox is driven through the real `Images` view rather than rendered directly, because the
 * bug was in the interaction between the child's handler and the parent's state — a directly
 * rendered `ImageViewer` has no parent to clear and cannot reproduce it.
 */
const item = (id: string) => ({
  id,
  filename: `${id}.png`,
  content_type: "image/png",
  size: 3,
  sha256: "h",
  version: 1,
  download_count: 0,
});

beforeEach(() => {
  blobUrl.mockReset();
  blobUrl.mockResolvedValue("blob:preview");
  getEntries.mockReset();
  getEntries.mockResolvedValue({ items: [item("abc123")], total: 1 });
  window.history.replaceState({}, "", "/images");
  window.dispatchEvent(new PopStateEvent("popstate"));
});

const openLightbox = async () => {
  const { default: Images } = await import("../src/views/Images.svelte");
  render(Images);
  await fireEvent.click(await screen.findByRole("button", { name: "查看 abc123.png" }));
  await screen.findByRole("button", { name: "详情" });
};

describe("lightbox 详情", () => {
  it("goes to the entry, not back to the gallery", async () => {
    await openLightbox();

    await fireEvent.click(screen.getByRole("button", { name: "详情" }));

    await waitFor(() => expect(window.location.pathname).toBe("/entry/abc123"));
  });

  it("closes the lightbox on the way", async () => {
    await openLightbox();

    await fireEvent.click(screen.getByRole("button", { name: "详情" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "详情" })).toBeNull());
  });
});