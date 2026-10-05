import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getEntries, getEntry, getSettings, getShares } = vi.hoisted(() => ({
  getEntries: vi.fn(),
  getEntry: vi.fn(),
  getSettings: vi.fn(),
  getShares: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      entries: { $get: getEntries },
      settings: { $get: getSettings },
      entry: {
        ":id": {
          $get: getEntry,
          $put: vi.fn(),
          shares: { $get: getShares, $post: vi.fn() },
          versions: { $get: vi.fn().mockResolvedValue({ versions: [] }) },
          downloads: { $get: vi.fn().mockResolvedValue({ total: 0, events: [] }) },
        },
      },
      shares: { ":id": { $delete: vi.fn(), $put: vi.fn() } },
    },
  },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: vi.fn(), hide: vi.fn(), value: null },
  confirmAction: vi.fn().mockResolvedValue(true),
}));

import Entries from "../src/views/Entries.svelte";
import EntryDetail from "../src/views/EntryDetail.svelte";

const item = (over: Record<string, unknown> = {}) => ({
  id: "abc123",
  share_id: "shr123",
  filename: "报告.pdf",
  content_type: "application/pdf",
  size: 3,
  sha256: "h",
  version: 1,
  upload_time: "2026-09-26T00:00:00.000Z",
  updated_time: "2026-09-26T00:00:00.000Z",
  expiration_time: null,
  note: null,
  guest_link_id: null,
  download_count: 0,
  ...over,
});

beforeEach(() => {
  for (const fn of [getEntries, getEntry, getSettings, getShares]) fn.mockReset();
  getSettings.mockResolvedValue({ storeForever: true, defaultDays: 30 });
  getEntry.mockResolvedValue(item());
  getShares.mockResolvedValue([]);
});

/**
 * The button is 分享管理 on both pages and opens the same dialog, rather than 复制链接.
 *
 * That label was answering a question it could not: an entry can have several links, each with its
 * own deadline, so "copy the link" has no single referent. Naming the action 管理 and putting every
 * link in a dialog with its own copy button costs one click and makes the referent explicit —
 * which is the whole argument for the extra step.
 */
describe("分享管理 entry points", () => {
  it("opens the dialog from the file list, for the row it was pressed on", async () => {
    getEntries.mockResolvedValue({ items: [item(), item({ id: "def456", filename: "别的.pdf" })], total: 2 });

    render(Entries);
    const buttons = await screen.findAllByRole("button", { name: "分享管理" });
    expect(buttons).toHaveLength(2);
    // No 复制链接 anywhere: the ambiguity is the reason the button is not that.
    expect(screen.queryByRole("button", { name: "复制链接" })).toBeNull();

    await fireEvent.click(buttons[1]);

    await waitFor(() =>
      expect(getShares).toHaveBeenCalledWith({ param: { id: "def456" } }),
    );
  });

  it("opens the same dialog from the entry's own page", async () => {
    render(EntryDetail, { props: { id: "abc123" } });
    await screen.findByRole("button", { name: "分享管理" });

    await fireEvent.click(screen.getByRole("button", { name: "分享管理" }));

    await waitFor(() =>
      expect(getShares).toHaveBeenCalledWith({ param: { id: "abc123" } }),
    );
  });

  it("opens nothing until the button is pressed", async () => {
    getEntries.mockResolvedValue({ items: [item()], total: 1 });

    render(Entries);
    await screen.findAllByRole("button", { name: "分享管理" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getShares).not.toHaveBeenCalled();
  });

  it("closes the dialog and leaves the list usable", async () => {
    getEntries.mockResolvedValue({ items: [item()], total: 1 });

    render(Entries);
    await fireEvent.click(await screen.findByRole("button", { name: "分享管理" }));
    await screen.findByRole("dialog");

    await fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("button", { name: "分享管理" })).toBeInTheDocument();
  });
});