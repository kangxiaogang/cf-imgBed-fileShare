import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Upload from "../src/views/Upload.svelte";

const { getSettings, uploadFiles, navigate } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  uploadFiles: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: { api: { settings: { $get: getSettings } } },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/upload", () => ({ uploadFiles }));
vi.mock("../src/lib/router.svelte", async () => {
  // The real module, so `route.query` reflects the location: the tab is read from the URL and
  // that is the behaviour under test. Only `navigate` is stubbed, to observe where the tabs
  // would send the user.
  const actual = await vi.importActual<typeof import("../src/lib/router.svelte")>(
    "../src/lib/router.svelte",
  );
  return { ...actual, navigate };
});
vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

/**
 * The tab is driven by the URL, which is what lets the gallery's "上传图片" open the image tab
 * directly. Held in local `$state` it always started on 文件 however the view was reached, and a
 * reload or the back button reset it.
 *
 * No `vi.resetModules` here: that gives the component and the Svelte runtime separate copies,
 * and the component's effects end up orphaned. The location is moved and `popstate` fired
 * instead — which is what the browser does, so the tests exercise the real path.
 */
const mountAt = async (url: string) => {
  window.history.replaceState({}, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
  render(Upload);
  await waitFor(() => expect(screen.getByRole("button", { name: "文件" })).toBeInTheDocument());
  return {
    fileTab: screen.getByRole("button", { name: "文件" }),
    imageTab: screen.getByRole("button", { name: "图片" }),
  };
};

const isActive = (tab: HTMLElement) => tab.className.includes("bg-sky-50");

beforeEach(() => {
  getSettings.mockReset();
  getSettings.mockResolvedValue({ storeForever: true, defaultDays: 30 });
  uploadFiles.mockReset();
  navigate.mockReset();
  // The tab is read from the URL, and the tests above move it around. Reset it so a test that
  // does not care about the tab gets the default one.
  window.history.replaceState({}, "", "/upload");
  window.dispatchEvent(new PopStateEvent("popstate"));
});

describe("Upload tab", () => {
  it("opens on the image tab when the URL asks for it", async () => {
    // The gallery's "上传图片" navigating here — the case that was reported.
    const { fileTab, imageTab } = await mountAt("/upload?mode=image");

    expect(isActive(imageTab)).toBe(true);
    expect(isActive(fileTab)).toBe(false);
  });

  it("opens on the file tab by default", async () => {
    const { fileTab, imageTab } = await mountAt("/upload");

    expect(isActive(fileTab)).toBe(true);
    expect(isActive(imageTab)).toBe(false);
  });

  it("ignores an unrecognised mode", async () => {
    const { fileTab } = await mountAt("/upload?mode=nonsense");
    expect(isActive(fileTab)).toBe(true);
  });

  it("navigates rather than mutating local state when the tab changes", async () => {
    const { fileTab, imageTab } = await mountAt("/upload");

    await fireEvent.click(imageTab);
    expect(navigate).toHaveBeenCalledWith("/upload?mode=image");

    await fireEvent.click(fileTab);
    expect(navigate).toHaveBeenCalledWith("/upload");
  });

  it("follows the back button out of the image tab", async () => {
    const { fileTab, imageTab } = await mountAt("/upload?mode=image");
    expect(isActive(imageTab)).toBe(true);

    window.history.replaceState({}, "", "/upload");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(isActive(fileTab)).toBe(true));
  });

  it("keeps the query out of the matched route", async () => {
    await mountAt("/upload?mode=image");
    // `route.segments` is what App.svelte routes on, so a query that leaked into the path
    // would stop the view from matching at all.
    const { route } = await import("../src/lib/router.svelte");
    expect(route.path).toBe("/upload");
    expect(route.segments).toEqual(["upload"]);
  });
});

describe("Upload results", () => {
  const item = (overrides: Record<string, unknown>) => ({
    id: "a",
    filename: "a.png",
    version: 1,
    sha256: "x",
    url: null,
    markdown: null,
    bbcode: null,
    deduped: false,
    ...overrides,
  });

  async function submitWith(items: unknown[]) {
    uploadFiles.mockResolvedValue(items);
    const { container } = render(Upload);
    // Stage a file through the picker's own input, the path the user takes.
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "a.bin", { type: "application/octet-stream" })],
      configurable: true,
    });
    await fireEvent.change(input);
    await fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    await screen.findByText("上传完成");
  }

  it("disables 复制全部链接 when no result has a link", async () => {
    // Non-image results answer with a null url. Joining `null` used to copy "\n" and report
    // success, so the button promised a link it did not have.
    await submitWith([item({ id: "a", filename: "a.bin" }), item({ id: "b", filename: "b.bin" })]);

    expect(screen.getByRole("button", { name: "复制全部链接" })).toBeDisabled();
    expect(screen.getAllByText("未分享").length).toBe(2);
  });

  it("enables 复制全部链接 once any result has one", async () => {
    await submitWith([
      item({ id: "a", filename: "a.bin" }),
      item({ id: "b", filename: "b.png", url: "https://x.example.com/img/b/b.png" }),
    ]);

    expect(screen.getByRole("button", { name: "复制全部链接" })).not.toBeDisabled();
    expect(screen.getByText("https://x.example.com/img/b/b.png")).toBeInTheDocument();
  });
});
