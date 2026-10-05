import type { Entry } from "@picoshare/shared";

export function selection(items: () => Entry[]) {
  let selected = $state<Set<string>>(new Set());

  const allSelected = $derived(
    items().length > 0 && items().every((entry) => selected.has(entry.id)),
  );

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleAll() {
    selected = allSelected ? new Set() : new Set(items().map((entry) => entry.id));
  }

  function remove(ids: string[]) {
    const next = new Set(selected);
    for (const id of ids) next.delete(id);
    selected = next;
  }

  function clear() {
    selected = new Set();
  }

  return {
    get selected() {
      return selected;
    },
    get count() {
      return selected.size;
    },
    get allSelected() {
      return allSelected;
    },
    toggle,
    toggleAll,
    remove,
    clear,
  };
}
