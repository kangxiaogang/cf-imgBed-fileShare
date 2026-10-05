import { beforeEach, describe, expect, it, vi } from "vitest";
import { entryActions } from "../src/lib/entryActions.svelte";
import { NETWORK_MESSAGE } from "../src/lib/errors";

const { deleteEntry, postBulkDelete, confirmAction, flashShow } = vi.hoisted(() => ({
  deleteEntry: vi.fn(),
  postBulkDelete: vi.fn(),
  confirmAction: vi.fn(),
  flashShow: vi.fn(),
}));

/**
 * The typed client is a nested proxy, so a mock has to reproduce the path to each route:
 * `api.api.entry[":id"].$delete()` and `api.api.entries.delete.$post()`.
 */
vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      entry: { ":id": { $delete: deleteEntry } },
      entries: { delete: { $post: postBulkDelete } },
    },
  },
  RequestError: class RequestError extends Error {},
}));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: flashShow, hide: vi.fn(), value: null },
  confirmAction,
}));

const entry = (id: string) => ({ id, filename: `${id}.png` }) as never;

const harness = (overrides: { items?: string[]; selected?: string[] } = {}) => {
  const list = {
    items: (overrides.items ?? ["a", "b"]).map((id) => entry(id)),
    removeLocal: vi.fn(),
  };
  const selection = {
    selected: new Set(overrides.selected ?? []),
    get count() {
      return this.selected.size;
    },
    remove: vi.fn(),
    clear: vi.fn(),
  };
  return { list, selection, actions: entryActions({ list, selection, noun: "个文件" }) };
};

beforeEach(() => {
  deleteEntry.mockReset();
  postBulkDelete.mockReset();
  confirmAction.mockReset();
  flashShow.mockReset();
});

describe("entryActions", () => {
  it("does nothing when the confirm dialog is declined", async () => {
    confirmAction.mockResolvedValue(false);
    const { list, actions } = harness();
    await actions.remove(entry("a"));
    expect(deleteEntry).not.toHaveBeenCalled();
    expect(list.removeLocal).not.toHaveBeenCalled();
  });

  it("deletes one entry and drops it from the list and the selection", async () => {
    confirmAction.mockResolvedValue(true);
    deleteEntry.mockResolvedValue({ ok: true });
    const { list, selection, actions } = harness();
    await actions.remove(entry("a"));
    expect(deleteEntry).toHaveBeenCalledWith({ param: { id: "a" } });
    expect(list.removeLocal).toHaveBeenCalledWith(["a"]);
    expect(selection.remove).toHaveBeenCalledWith(["a"]);
    expect(flashShow).toHaveBeenCalledWith("已删除");
  });

  it("keeps local state intact when the delete fails", async () => {
    confirmAction.mockResolvedValue(true);
    deleteEntry.mockRejectedValue(new Error("文件已过期"));
    const { list, actions } = harness();
    await actions.remove(entry("a"));
    expect(list.removeLocal).not.toHaveBeenCalled();
    expect(flashShow).toHaveBeenCalledWith("文件已过期", "error");
  });

  it("bulk deletes the selection and clears it", async () => {
    confirmAction.mockResolvedValue(true);
    postBulkDelete.mockResolvedValue({ ok: true, deleted: 2 });
    const { list, selection, actions } = harness({ selected: ["a", "b"] });
    await actions.removeSelected();
    expect(postBulkDelete).toHaveBeenCalledWith({ json: { ids: ["a", "b"] } });
    expect(list.removeLocal).toHaveBeenCalledWith(["a", "b"]);
    expect(selection.clear).toHaveBeenCalled();
  });

  it("keeps the selection when a bulk delete fails", async () => {
    // The single delete had this covered and the bulk one did not, which is how a partial
    // success reads as a total one: `res.deleted` is not available on this path, so a
    // rejection that reported nothing would leave the rows on screen with the tick still in
    // them and no explanation.
    confirmAction.mockResolvedValue(true);
    postBulkDelete.mockRejectedValue(new Error(NETWORK_MESSAGE));
    const { list, selection, actions } = harness({ selected: ["a", "b"] });

    await actions.removeSelected();

    expect(list.removeLocal).not.toHaveBeenCalled();
    expect(selection.clear).not.toHaveBeenCalled();
    expect(flashShow).toHaveBeenCalledWith(NETWORK_MESSAGE, "error");
    // Never the success wording, whatever else happens.
    expect(flashShow).not.toHaveBeenCalledWith(expect.stringContaining("已删除"), expect.anything());
  });

  it("runs the onDeleted hook with the removed ids", async () => {
    confirmAction.mockResolvedValue(true);
    deleteEntry.mockResolvedValue({ ok: true });
    const onDeleted = vi.fn();
    const list = { items: [], removeLocal: vi.fn() };
    const actions = entryActions({
      list: list as never,
      selection: { selected: new Set(), remove: vi.fn(), clear: vi.fn() } as never,
      noun: "张图片",
      onDeleted,
    });
    await actions.remove(entry("a"));
    expect(onDeleted).toHaveBeenCalledWith(["a"]);
  });

  it("does not send a request for an empty selection", async () => {
    confirmAction.mockResolvedValue(true);
    const { actions } = harness({ selected: [] });
    await actions.removeSelected();
    expect(confirmAction).not.toHaveBeenCalled();
    expect(postBulkDelete).not.toHaveBeenCalled();
  });
});