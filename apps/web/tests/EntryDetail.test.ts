import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  confirmAction,
  deleteEntry,
  download,
  flashShow,
  getDownloads,
  getEntry,
  getShares,
  getSettings,
  getVersions,
  navigate,
  postShare,
} = vi.hoisted(() => ({
  confirmAction: vi.fn(),
  deleteEntry: vi.fn(),
  download: vi.fn(),
  flashShow: vi.fn(),
  getDownloads: vi.fn(),
  getEntry: vi.fn(),
  getShares: vi.fn(),
  getSettings: vi.fn(),
  getVersions: vi.fn(),
  navigate: vi.fn(),
  postShare: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      settings: { $get: getSettings },
      entry: {
        ":id": {
          $get: getEntry,
          $put: vi.fn(),
          $delete: deleteEntry,
          shares: { $get: getShares, $post: postShare },
          versions: {
            $get: getVersions,
            ":version": { $delete: vi.fn() },
          },
          downloads: { $get: getDownloads },
        },
      },
    },
  },
  verifySecret: vi.fn(),
  download,
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: flashShow, hide: vi.fn(), value: null },
  confirmAction,
}));
vi.mock("../src/lib/router.svelte", () => ({ navigate, route: { query: new URLSearchParams() } }));

import { NETWORK_MESSAGE } from "../src/lib/errors";
import EntryDetail from "../src/views/EntryDetail.svelte";
// Real, not mocked: the public link is an absolute URL, and hardcoding an origin here would make
// this file the second place that has to change when the origin does.
import { shortLink } from "../src/lib/format";

const item = (over: Record<string, unknown> = {}) => ({
  id: "abc123",
  share_id: null as string | null,
  filename: "报告.pdf",
  content_type: "application/pdf",
  size: 3,
  sha256: "h",
  // Deliberately not 1: a replaced file's bytes live at its current version, so a save that asks
  // for version 1 would hand back the file as it was before the edit.
  version: 3,
  upload_time: "2026-09-26T00:00:00.000Z",
  updated_time: "2026-09-26T00:00:00.000Z",
  expiration_time: null,
  note: null,
  guest_link_id: null,
  download_count: 7,
  ...over,
});

beforeEach(() => {
  for (const fn of [
    confirmAction,
    deleteEntry,
    download,
    flashShow,
    getDownloads,
    getEntry,
    getShares,
    getSettings,
    getVersions,
    navigate,
    postShare,
  ])
    fn.mockReset();
  confirmAction.mockResolvedValue(true);
  getSettings.mockResolvedValue({ storeForever: true, defaultDays: 30 });
  getEntry.mockResolvedValue(item());
  getVersions.mockResolvedValue({ versions: [] });
  // The route answers with the array itself, not `{ shares }` — `json(await shares.list(...))`.
  getShares.mockResolvedValue([]);
  getDownloads.mockResolvedValue({ total: 0, events: [] });
  download.mockResolvedValue(undefined);
});

const mount = async (over: Record<string, unknown> = {}) => {
  getEntry.mockResolvedValue(item(over));
  render(EntryDetail, { props: { id: "abc123" } });
  const button = await screen.findByRole("button", { name: "下载" });
  await waitFor(() => expect(getShares).toHaveBeenCalled());
  return button;
};

/**
 * Files get no link at upload — a link is a decision to hand something to somebody — so only
 * images arrive with one. The 下载 button used to hang off `share_id`, which quietly made the
 * owner's own file undownloadable: not shared yet meant not downloadable *at all*, including by
 * the person who uploaded it ten seconds earlier.
 *
 * So the button is unconditional, and the route behind it depends on whether a public link exists.
 */
/**
 * The one thing this page must never do is report a delete that did not happen.
 *
 * The flow is a plain `await` before anything local changes, so there was no optimistic update
 * to get wrong — but there was also no test, on this page or on the list, for what happens when
 * the request fails. A backend that is not running answers that the only way it can, by not
 * answering, which is the case where a silent success would be most believable.
 */
describe("EntryDetail 删除", () => {
  const press = async () => {
    render(EntryDetail, { props: { id: "abc123" } });
    await screen.findByRole("button", { name: "删除" });
    await fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(confirmAction).toHaveBeenCalled());
  };

  it("reports the failure and stays on the page when the delete does not happen", async () => {
    deleteEntry.mockRejectedValue(new Error(NETWORK_MESSAGE));

    await press();
    await waitFor(() => expect(flashShow).toHaveBeenCalledWith(NETWORK_MESSAGE, "error"));

    // Navigating away would leave the list without the file and the entry page without it too,
    // which is what a delete that never reached the server looks like from here.
    expect(navigate).not.toHaveBeenCalled();
    expect(flashShow).not.toHaveBeenCalledWith("已删除", expect.anything());
  });

  it("goes back to the list once the delete has actually happened", async () => {
    deleteEntry.mockResolvedValue({ ok: true });

    await press();
    await waitFor(() => expect(flashShow).toHaveBeenCalledWith("已删除"));

    expect(navigate).toHaveBeenCalledWith("/");
  });

  it("does not send anything when the confirmation is declined", async () => {
    confirmAction.mockResolvedValue(false);

    await press();

    expect(deleteEntry).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("EntryDetail 下载", () => {
  it("offers the owner a download for a file nobody has shared", async () => {
    await mount();
    expect(screen.getByRole("button", { name: "下载" })).toBeInTheDocument();
  });

  it("saves an unshared file through the owner's own authenticated route", async () => {
    const button = await mount();

    await fireEvent.click(button);

    await waitFor(() =>
      expect(download).toHaveBeenCalledWith(
        "/api/entry/abc123/versions/3/content",
        "报告.pdf",
      ),
    );
  });

  it("does not mint a share to log the owner's own save", async () => {
    // Creating one would leave behind a public link to a file the owner never shared, which is
    // the exact thing choosing not to auto-share was for.
    await fireEvent.click(await mount());

    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(postShare).not.toHaveBeenCalled();
  });

  it("saves a shared file through the public link, which is the route that records it", async () => {
    const button = await mount({ share_id: "shr123" });

    await fireEvent.click(button);

    await waitFor(() => expect(download).toHaveBeenCalledWith(shortLink("shr123"), "报告.pdf"));
  });

  it("re-reads the crawl history after a save that was recorded", async () => {
    // The bump of the history's refresh key is how "the record was written" becomes visible:
    // the panel re-reads the server rather than guessing.
    await fireEvent.click(await mount({ share_id: "shr123" }));

    await waitFor(() => expect(getDownloads).toHaveBeenCalledTimes(2));
  });

  it("leaves the crawl history alone when the owner's own save was not recorded", async () => {
    // The history exists to answer "has this been crawled". The owner's pull of their own file is
    // not evidence of that — which is the reason the fallback above is the authenticated route
    // and not a public link minted for the occasion.
    await fireEvent.click(await mount());

    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(getDownloads).toHaveBeenCalledTimes(1);
  });

  it("falls back to the authenticated route once every share is gone", async () => {
    // share_id is computed as the oldest *usable* share, so revoking the last one leaves the
    // entry with none. The file is untouched and still the owner's to save.
    const button = await mount({ share_id: null });

    await fireEvent.click(button);

    await waitFor(() =>
      expect(download).toHaveBeenCalledWith("/api/entry/abc123/versions/3/content", "报告.pdf"),
    );
  });
});

describe("share summary", () => {
  it("re-reads the entry when the share dialog closes", async () => {
    // The dialog creates and revokes shares; the summary above it reports what is left. Without
    // this the page kept saying 未分享 after a link was made, and 下载 would keep taking the
    // unshared route even though a public link now existed.
    await mount({ share_id: null });
    const before = getEntry.mock.calls.length;

    await fireEvent.click(screen.getByRole("button", { name: "分享管理" }));
    await fireEvent.click(await screen.findByRole("button", { name: "关闭" }));

    await waitFor(() => expect(getEntry.mock.calls.length).toBeGreaterThan(before));
  });
});
