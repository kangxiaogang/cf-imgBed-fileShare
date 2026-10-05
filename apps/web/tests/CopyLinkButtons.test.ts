import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import CopyLinkButtons from "../src/components/CopyLinkButtons.svelte";

const { copyWithFlash } = vi.hoisted(() => ({ copyWithFlash: vi.fn() }));
vi.mock("../src/lib/clipboard", () => ({ copyWithFlash }));

describe("CopyLinkButtons", () => {
  it("copies the direct link with an image-specific message", async () => {
    render(CopyLinkButtons, { props: { url: "https://x/img/1/a.png", filename: "a.png", image: true } });

    await fireEvent.click(screen.getByText("复制直链"));

    expect(copyWithFlash).toHaveBeenCalledWith("https://x/img/1/a.png", "图片直链已复制");
  });

  it("copies markdown, html and bbcode for images", async () => {
    render(CopyLinkButtons, { props: { url: "https://x/img/1/a.png", filename: "a.png", image: true } });

    await fireEvent.click(screen.getByText("复制 Markdown"));
    expect(copyWithFlash).toHaveBeenCalledWith("![a.png](https://x/img/1/a.png)", "Markdown 已复制");

    await fireEvent.click(screen.getByText("复制 HTML"));
    expect(copyWithFlash).toHaveBeenCalledWith('<img src="https://x/img/1/a.png" alt="a.png" />', "HTML 已复制");

    await fireEvent.click(screen.getByText("复制 BBCode"));
    expect(copyWithFlash).toHaveBeenCalledWith("[img]https://x/img/1/a.png[/img]", "BBCode 已复制");
  });

  it("only renders the direct link button when rich is disabled", () => {
    render(CopyLinkButtons, { props: { url: "https://x/-1", filename: "a.txt", rich: false } });

    expect(screen.getByText("复制直链")).toBeInTheDocument();
    expect(screen.queryByText("复制 Markdown")).toBeNull();
    expect(screen.queryByText("复制 BBCode")).toBeNull();
  });
});
