import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { confirmAnswer, deleteShare, getShares, postShare, putShare } = vi.hoisted(() => ({
  confirmAnswer: vi.fn(),
  deleteShare: vi.fn(),
  getShares: vi.fn(),
  postShare: vi.fn(),
  putShare: vi.fn(),
}));

const copied: string[] = [];
vi.mock("../src/lib/clipboard", () => ({
  copyWithFlash: (text: string) => {
    copied.push(text);
    return Promise.resolve();
  },
}));

vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      settings: { $get: vi.fn() },
      entry: {
        ":id": {
          $get: vi.fn(),
          $put: vi.fn(),
          shares: { $get: getShares, $post: postShare },
          versions: { $get: vi.fn().mockResolvedValue({ versions: [] }) },
          downloads: { $get: vi.fn().mockResolvedValue({ total: 0, events: [] }) },
        },
      },
      shares: { ":id": { $delete: deleteShare, $put: putShare } },
    },
  },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: vi.fn(), hide: vi.fn(), value: null },
  confirmAction: confirmAnswer,
}));

import ShareManager from "../src/components/ShareManager.svelte";

const share = (over: Record<string, unknown> = {}) => ({
  id: "shr1",
  entry_id: "abc123",
  label: "给同事",
  expires_at: null,
  created_time: "2026-09-26T00:00:00.000Z",
  ...over,
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

beforeEach(() => {
  copied.length = 0;
  for (const fn of [confirmAnswer, deleteShare, getShares, postShare, putShare]) fn.mockReset();
  confirmAnswer.mockResolvedValue(true);
  deleteShare.mockResolvedValue({ ok: true });
  putShare.mockResolvedValue(share());
});

const mount = async (shares: unknown[] = [], onClose = vi.fn()) => {
  getShares.mockResolvedValue(shares);
  render(ShareManager, { props: { entryId: "abc123", filename: "报告.pdf", onClose } });
  // Wait for the dialog's *content*, not for the request: the load is fired while the component is
  // being set up, so "it was called" is true a tick before anything is on screen.
  await waitFor(() => expect(screen.getByRole("button", { name: "创建分享链接" })).toBeInTheDocument());
  expect(getShares).toHaveBeenCalledWith({ param: { id: "abc123" } });
  return onClose;
};

/**
 * Two behaviours only became expressible once a link was separate from a file:
 *
 * - A link can be taken back without the file going with it. Before shares, revoking a link meant
 *   deleting the entry, because the entry's id *was* the link.
 * - A link's deadline is its own. The file's expiry deletes the entry; a share's answers 410 and
 *   leaves the entry where it is.
 *
 * And one behaviour of the dialog itself: an entry can have several links, so nothing here offers
 * to copy "the" link. Each row copies its own.
 */
describe("ShareManager", () => {
  it("is a dialog, so it reads as an overlay on the list it was opened from", async () => {
    await mount([]);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby", "share-manager-title");
    expect(screen.getByText("分享链接")).toBeInTheDocument();
  });

  it("sits below the confirm dialog it opens for a revoke", async () => {
    // Revoking asks for confirmation, and that confirm is rendered by App as a sibling of the
    // page — so anything with a higher z-index here paints over the question. It then looks like
    // the click did nothing: the dialog is invisible, nothing is clickable, and the promise
    // behind `confirmAction` never settles, which leaves the revoke half-applied and the list
    // spinning. This is the tier the image lightbox uses for the same reason.
    const CONFIRM_Z = 40; // App.svelte's confirm dialog
    await mount([]);

    const z = /z-(\d+)/.exec(screen.getByRole("dialog").className)?.[1];
    expect(z, "the dialog has no z-index class").toBeDefined();
    expect(Number(z)).toBeLessThan(CONFIRM_Z);
  });

  it("takes focus, so the keyboard does not stay behind it on the list", async () => {
    await mount([]);
    expect(screen.getByRole("dialog")).toHaveFocus();
  });

  it("says which file it is managing", async () => {
    await mount([]);
    expect(screen.getByText("报告.pdf")).toBeInTheDocument();
  });

  it("lists every link with its note and deadline", async () => {
    await mount([
      share({ id: "shr1", label: "给同事", expires_at: null }),
      share({ id: "shr2", label: null, expires_at: daysAhead(7) }),
    ]);

    expect(screen.getByText("给同事")).toBeInTheDocument();
    expect(screen.getByText("永不过期")).toBeInTheDocument();
    // An unlabelled link still has to be identifiable, or the list is two anonymous rows.
    expect(screen.getByText("（无备注）")).toBeInTheDocument();
    expect(screen.getByText("当前 2 条可用")).toBeInTheDocument();
  });

  it("marks a passed deadline and stops counting it", async () => {
    await mount([
      share({ id: "shr1", expires_at: daysAgo(2) }),
      share({ id: "shr2", expires_at: daysAhead(7) }),
    ]);

    expect(screen.getByText("已失效")).toBeInTheDocument();
    expect(screen.getByText("当前 1 条可用")).toBeInTheDocument();
    // Nothing to un-expire: that deadline has already gone by.
    expect(screen.getAllByRole("button", { name: "改为永不过期" })).toHaveLength(1);
  });

  it("copies each row's own link, so there is never a question of which", async () => {
    // The reason this is a dialog at all: with two live links a single 复制链接 button cannot say
    // which one it would hand over.
    await mount([
      share({ id: "shrAAA", label: "给同事" }),
      share({ id: "shrBBB", label: "给供应商" }),
    ]);

    await fireEvent.click(screen.getAllByRole("button", { name: "复制" })[1]);

    expect(copied).toHaveLength(1);
    expect(copied[0]).toContain("/-shrBBB");
  });

  it("creates a link with a note and a deadline", async () => {
    await mount([]);
    postShare.mockResolvedValue(share({ id: "shrNew" }));

    await fireEvent.input(screen.getByLabelText("分享备注"), { target: { value: "发给设计" } });
    await fireEvent.input(screen.getByLabelText("链接有效天数"), { target: { value: "7" } });
    await fireEvent.click(screen.getByRole("button", { name: "创建分享链接" }));

    await waitFor(() =>
      expect(postShare).toHaveBeenCalledWith({
        param: { id: "abc123" },
        json: { label: "发给设计", expiresInDays: 7 },
      }),
    );
  });

  it("treats an empty deadline as a link that never ends", async () => {
    await mount([]);
    postShare.mockResolvedValue(share({ id: "shrNew" }));

    await fireEvent.click(screen.getByRole("button", { name: "创建分享链接" }));

    await waitFor(() =>
      expect(postShare).toHaveBeenCalledWith({
        param: { id: "abc123" },
        json: { label: null, expiresInDays: null },
      }),
    );
  });

  it("edits a note inline, and sends nothing else", async () => {
    // Only the label. A partial update is the point: sending the deadline too would reset one the
    // owner opened the note to change nothing about.
    await mount([share({ id: "shr1", label: "旧备注", expires_at: daysAhead(7) })]);
    putShare.mockResolvedValue(share({ id: "shr1", label: "新备注", expires_at: daysAhead(7) }));

    await fireEvent.click(screen.getByRole("button", { name: "备注" }));
    await fireEvent.input(screen.getByLabelText("链接备注"), { target: { value: "新备注" } });
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(putShare).toHaveBeenCalledWith({
        param: { id: "shr1" },
        json: { label: "新备注" },
      }),
    );
  });

  it("sends no request when the note was not actually changed", async () => {
    await mount([share({ id: "shr1", label: "原样" })]);

    await fireEvent.click(screen.getByRole("button", { name: "备注" }));
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(putShare).not.toHaveBeenCalled();
  });

  it("revokes a link without touching the entry", async () => {
    await mount([share({ id: "shr1" })]);

    await fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    await waitFor(() => expect(deleteShare).toHaveBeenCalledWith({ param: { id: "shr1" } }));
    // Scoped to the share: the entry is not in this call, and that is the claim the confirm makes.
    expect(deleteShare.mock.calls[0][0].param.id).not.toBe("abc123");
    await waitFor(() => expect(screen.getByText(/还没有分享链接/)).toBeInTheDocument());
  });

  it("does not revoke when the confirmation is declined", async () => {
    confirmAnswer.mockResolvedValue(false);
    await mount([share({ id: "shr1" })]);

    await fireEvent.click(screen.getByRole("button", { name: "撤销" }));

    expect(deleteShare).not.toHaveBeenCalled();
  });

  it("can turn a deadline back off", async () => {
    await mount([share({ id: "shr1", expires_at: daysAhead(7) })]);

    await fireEvent.click(screen.getByRole("button", { name: "改为永不过期" }));

    await waitFor(() =>
      expect(putShare).toHaveBeenCalledWith({
        param: { id: "shr1" },
        json: { expiresInDays: null },
      }),
    );
  });

  it("closes on Escape, on the backdrop and on the button", async () => {
    const onClose = await mount([]);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    await fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("does not close when the click lands inside the panel", async () => {
    // Otherwise every click on a link row or the create form would dismiss the dialog.
    const onClose = await mount([]);

    await fireEvent.click(screen.getByRole("dialog").querySelector(".card") as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
  });

  it("says the file survives a revoke, because that is what people are afraid of", async () => {
    await mount([]);
    expect(screen.getByText(/不会删除文件/)).toBeInTheDocument();
  });

  it("reports a failed load rather than showing an empty list", async () => {
    // An empty list and a failed request look identical; only one is true, and "you have no links
    // yet" on a dialog that could not load is a lie.
    getShares.mockRejectedValue(new Error("boom"));
    render(ShareManager, { props: { entryId: "abc123", onClose: vi.fn() } });

    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "创建分享链接" })).toBeNull();
  });
});