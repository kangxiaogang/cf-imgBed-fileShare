import { describe, expect, it, vi } from "vitest";
import { copyText, copyWithFlash } from "../src/lib/clipboard";
import { flash } from "../src/lib/ui.svelte";

vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

const setClipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};

describe("copyText", () => {
  it("returns true and writes the text on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("returns false when the clipboard API rejects", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    await expect(copyText("hello")).resolves.toBe(false);
  });
});

describe("copyWithFlash", () => {
  it("flashes a success message", async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    await copyWithFlash("x", "已复制");
    expect(flash.show).toHaveBeenCalledWith("已复制", "ok");
  });

  it("flashes an error message on failure", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    await copyWithFlash("x", "已复制");
    expect(flash.show).toHaveBeenCalledWith("复制失败，请手动复制", "error");
  });
});
