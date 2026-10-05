import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEntries, navigate, getSettings } = vi.hoisted(() => ({
  getEntries: vi.fn(),
  navigate: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { api: { entries: { $get: getEntries }, settings: { $get: getSettings } } },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/router.svelte", () => ({ navigate, route: { path: "/images", segments: ["images"], query: new URLSearchParams() } }));
vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

import Images from "../src/views/Images.svelte";

/**
 * The link in the chain from the gallery to the image tab.
 *
 * `UploadTab.test.ts` covers the receiving end — that `?mode=image` selects the image tab. This
 * covers the producing end, which is the half that was broken: the batch edit that introduced
 * the URL-driven tab threw two steps before this line, so "上传图片" kept navigating to a bare
 * `/upload` and the tab never changed. Every test stayed green, because neither end was
 * connected to the other.
 */
beforeEach(() => {
  getEntries.mockReset();
  getEntries.mockResolvedValue({ items: [], total: 0 });
  navigate.mockReset();
  window.history.replaceState({}, "", "/images");
});

const clickUpload = async () => {
  render(Images);
  const button = await screen.findByRole("button", { name: "上传图片" });
  await fireEvent.click(button);
  await waitFor(() => expect(navigate).toHaveBeenCalled());
  return navigate.mock.calls[0]?.[0] as string;
};

describe("Images", () => {
  it("sends 上传图片 to the upload page's image tab", async () => {
    expect(await clickUpload()).toBe("/upload?mode=image");
  });

  it("does not send the gallery's file tab anywhere near the image tab", async () => {
    // A bare `/upload` is the file tab, which is what the button used to do.
    const target = await clickUpload();
    expect(target).not.toBe("/upload");
  });

  it("leaves the file list's own upload button on the file tab", async () => {
    // The two headers look identical; only one of them is about images.
    const { default: Entries } = await import("../src/views/Entries.svelte");
    render(Entries);
    await fireEvent.click(await screen.findByRole("button", { name: "上传文件" }));
    expect(navigate).toHaveBeenCalledWith("/upload");
  });
});
