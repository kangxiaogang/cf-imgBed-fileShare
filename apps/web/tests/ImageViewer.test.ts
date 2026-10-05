import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { blobUrl } = vi.hoisted(() => ({ blobUrl: vi.fn() }));

vi.mock("../src/lib/api", () => ({ blobUrl, download: vi.fn() }));
vi.mock("../src/lib/router.svelte", () => ({ navigate: vi.fn() }));

import type { Entry } from "@picoshare/shared";
import ImageViewer from "../src/components/ImageViewer.svelte";

const entry = {
  id: "abc123",
  filename: "照片.png",
  content_type: "image/png",
  size: 3,
  sha256: "h",
  version: 1,
  upload_time: "2026-09-26T00:00:00.000Z",
  updated_time: "2026-09-26T00:00:00.000Z",
  expiration_time: null,
  note: null,
  guest_link_id: null,
} as unknown as Entry;

const setup = async () => {
  const onClose = vi.fn();
  const onDelete = vi.fn();
  render(ImageViewer, { props: { entry, onClose, onDelete } });
  await waitFor(() => expect(screen.getByAltText("照片.png")).toBeInTheDocument());
  return { onClose, onDelete };
};

beforeEach(() => {
  blobUrl.mockReset();
  blobUrl.mockResolvedValue("blob:preview");
});

describe("ImageViewer", () => {
  /**
   * The Escape handler used to sit on the dialog element. Key events are delivered to
   * `document.activeElement` and bubble through *that* element's ancestors, and the dialog is a
   * sibling of the gallery that opened it — so Escape did nothing unless something inside the
   * dialog happened to hold focus, which is why it read as broken rather than flaky.
   */
  it("closes on Escape", async () => {
    const { onClose } = await setup();
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape with no focus inside the dialog at all", async () => {
    const { onClose } = await setup();
    // The state a user is actually in after clicking a gallery tile: focus is on the tile,
    // outside the dialog.
    expect(document.activeElement?.tagName).not.toBe("IMG");

    await fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    expect(onClose).toHaveBeenCalled();
  });

  it("ignores other keys", async () => {
    const { onClose } = await setup();
    for (const key of ["Enter", "a", "ArrowRight", " "]) {
      await fireEvent.keyDown(window, { key });
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on the backdrop but not on the image", async () => {
    const { onClose } = await setup();
    const dialog = screen.getByRole("dialog");

    await fireEvent.click(screen.getByAltText("照片.png"));
    expect(onClose).not.toHaveBeenCalled();

    await fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalled();
  });

  it("closes from the close button", async () => {
    const { onClose } = await setup();
    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalled();
  });
});
