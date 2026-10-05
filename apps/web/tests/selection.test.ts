import type { Entry } from "@picoshare/shared";
import { describe, expect, it } from "vitest";
import { selection } from "../src/lib/selection.svelte";

const entry = (id: string) => ({ id, filename: `${id}.png` }) as Entry;

describe("selection", () => {
  it("toggles individual entries", () => {
    const sel = selection(() => [entry("a"), entry("b")]);

    expect(sel.count).toBe(0);
    sel.toggle("a");
    expect(sel.selected.has("a")).toBe(true);
    expect(sel.count).toBe(1);
    sel.toggle("a");
    expect(sel.count).toBe(0);
  });

  it("toggles all entries and reports allSelected", () => {
    const sel = selection(() => [entry("a"), entry("b")]);

    sel.toggleAll();
    expect(sel.allSelected).toBe(true);
    expect(sel.count).toBe(2);
    sel.toggleAll();
    expect(sel.allSelected).toBe(false);
    expect(sel.count).toBe(0);
  });

  it("removes and clears entries", () => {
    const sel = selection(() => [entry("a"), entry("b")]);

    sel.toggleAll();
    sel.remove(["a"]);
    expect([...sel.selected]).toEqual(["b"]);
    sel.clear();
    expect(sel.count).toBe(0);
  });

  it("never reports allSelected for an empty list", () => {
    const sel = selection(() => []);
    expect(sel.allSelected).toBe(false);
  });
});
