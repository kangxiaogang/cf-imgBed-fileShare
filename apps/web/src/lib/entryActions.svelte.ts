import type { Entry } from "@picoshare/shared";
import { api } from "./api";
import { confirmAction, flash } from "./ui.svelte";
import { errorMessage } from "./errors";

export type EntryList<T> = {
  items: Entry[];
  removeLocal(ids: string[]): void;
};

export type EntrySelection = {
  selected: Set<string>;
  count: number;
  remove(ids: string[]): void;
  clear(): void;
};

export type EntryActionsOptions = {
  list: EntryList<Entry>;
  selection: EntrySelection;
  /** Noun for the confirm dialog and the toast, e.g. "个文件" or "张图片". */
  noun: string;
  /** Runs after a successful delete, e.g. to close a lightbox showing the entry. */
  onDeleted?: (ids: string[]) => void;
};

/**
 * The delete flows shared by the file list and the image gallery. Both views were
 * near-identical line for line, and the copy-paste is how they drifted apart.
 */
export function entryActions(options: EntryActionsOptions) {
  const { list, selection, noun } = options;
  let busy = $state(false);

  function afterDelete(ids: string[]) {
    list.removeLocal(ids);
    selection.remove(ids);
    options.onDeleted?.(ids);
  }

  async function remove(entry: Entry) {
    if (!(await confirmAction(`确定删除「${entry.filename}」吗？此操作不可恢复。`))) return;
    try {
      await api.api.entry[":id"].$delete({ param: { id: entry.id } });
      afterDelete([entry.id]);
      flash.show("已删除");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  async function removeSelected() {
    const ids = [...selection.selected];
    if (!ids.length) return;
    if (!(await confirmAction(`确定删除选中的 ${ids.length} ${noun}吗？此操作不可恢复。`))) return;
    busy = true;
    try {
      const res = await api.api.entries.delete.$post({ json: { ids } });
      afterDelete(ids);
      selection.clear();
      flash.show(`已删除 ${res.deleted} ${noun}`);
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      busy = false;
    }
  }

  return {
    get busy() {
      return busy;
    },
    remove,
    removeSelected,
  };
}
