import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { blobUrl, download, getDownloads } = vi.hoisted(() => ({
  blobUrl: vi.fn(),
  download: vi.fn(),
  getDownloads: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  blobUrl,
  download,
  api: { api: { entry: { ":id": { downloads: { $get: getDownloads } } } } },
}));
vi.mock("../src/lib/router.svelte", () => ({ navigate: vi.fn() }));

import type { Entry } from "@picoshare/shared";
import ImageViewer from "../src/components/ImageViewer.svelte";

/**
 * `share_id` is what the public link is built from now, not `id`. Without it the lightbox
 * renders "未分享" and there is no download button to press — which is correct behaviour and made
 * this fixture silently untestable rather than failing loudly.
 */
const entry = {
  id: "abc123",
  share_id: "shr123",
  filename: "照片.png",
  content_type: "image/png",
  size: 3,
  sha256: "h",
  version: 1,
} as unknown as Entry;

/**
 * `/api/entry/:id/preview` carries two different acts and the route cannot tell them apart:
 * the lightbox uses it to *show* the image, and the download button beside it used it to *save*
 * one. Counting neither is right for the first and wrong for the second, so saving from the
 * gallery — the natural way to save an image — never appeared in the history.
 *
 * Saving now goes through the public link, the same route anyone outside the app would use.
 */
beforeEach(() => {
  blobUrl.mockReset();
  blobUrl.mockResolvedValue("blob:preview");
  download.mockReset();
  download.mockResolvedValue(undefined);
  getDownloads.mockReset();
});

const setup = async () => {
  const onClose = vi.fn();
  render(ImageViewer, { props: { entry, onClose, onDelete: vi.fn() } });
  await waitFor(() => expect(screen.getByAltText("照片.png")).toBeInTheDocument());
  return screen.getByRole("button", { name: "下载" });
};

describe("ImageViewer download", () => {
  it("saves through the public link, which is the route that records", async () => {
    const button = await setup();

    await fireEvent.click(button);

    expect(download).toHaveBeenCalledTimes(1);
    const [path, filename] = download.mock.calls[0] as [string, string];
    // The share's id, not the entry's: that is the token in every link handed out from now on.
    expect(path).toContain("/img/shr123/");
    expect(path).not.toContain("/img/abc123/");
    expect(path).not.toContain("/preview");
    expect(filename).toBe("照片.png");
  });

  it("still renders the image through the preview route", async () => {
    // The display path must stay on `/preview`, or every tile in the gallery would count as a
    // download.
    await setup();
    expect(blobUrl).toHaveBeenCalledWith("/api/entry/abc123/preview");
  });
});
