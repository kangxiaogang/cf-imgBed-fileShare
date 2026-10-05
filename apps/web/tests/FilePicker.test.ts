import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import FilePicker from "../src/components/FilePicker.svelte";

vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

const pick = async (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await fireEvent.change(input);
};

const fileInput = (container: HTMLElement) =>
  container.querySelector('input[type="file"]') as HTMLInputElement;

describe("FilePicker", () => {
  it("renders the default hint and textarea", () => {
    const { container } = render(FilePicker, { props: { files: [], text: "" } });

    expect(screen.getByText("支持拖拽、点击选择或多选文件")).toBeInTheDocument();
    expect(container.querySelector("textarea")).not.toBeNull();
  });

  it("hides the textarea in image mode", () => {
    const { container } = render(FilePicker, { props: { files: [], text: "", imageOnly: true } });

    expect(container.querySelector("textarea")).toBeNull();
  });

  it("lists accepted files and allows removing them", async () => {
    const { container, getByText, queryByText } = render(FilePicker, {
      props: { files: [], text: "" },
    });

    await pick(fileInput(container), [new File(["x"], "a.txt", { type: "text/plain" })]);
    expect(getByText("a.txt")).toBeInTheDocument();

    await fireEvent.click(screen.getByText("移除"));
    expect(queryByText("a.txt")).toBeNull();
  });

  it("accepts images and rejects other files in image mode", async () => {
    const { flash } = await import("../src/lib/ui.svelte");
    const { container, getByText, queryByText } = render(FilePicker, {
      props: { files: [], text: "", imageOnly: true },
    });

    await pick(fileInput(container), [new File(["x"], "a.png", { type: "image/png" })]);
    expect(getByText("a.png")).toBeInTheDocument();

    await pick(fileInput(container), [new File(["x"], "b.txt", { type: "text/plain" })]);
    expect(queryByText("b.txt")).toBeNull();
    expect(flash.show).toHaveBeenCalledWith("「b.txt」不是图片，已忽略", "error");
  });

  it("caps the selection at maxFiles instead of letting the server reject the request", async () => {
    const { flash } = await import("../src/lib/ui.svelte");
    const { container, getByText, queryByText } = render(FilePicker, {
      props: { files: [], text: "", maxFiles: 2 },
    });

    await pick(fileInput(container), [
      new File(["x"], "a.txt", { type: "text/plain" }),
      new File(["x"], "b.txt", { type: "text/plain" }),
      new File(["x"], "c.txt", { type: "text/plain" }),
    ]);
    expect(getByText("a.txt")).toBeInTheDocument();
    expect(getByText("b.txt")).toBeInTheDocument();
    expect(queryByText("c.txt")).toBeNull();
    expect(flash.show).toHaveBeenCalledWith("一次最多选择 2 个文件，已忽略多余的 1 个", "error");

    // The cap counts what is already staged, so a second drop cannot walk past it.
    await pick(fileInput(container), [new File(["x"], "d.txt", { type: "text/plain" })]);
    expect(queryByText("d.txt")).toBeNull();
  });
});
