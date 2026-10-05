import { render, screen } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PreviewHost from "./fixtures/PreviewHost.svelte";

const { blobUrl } = vi.hoisted(() => ({ blobUrl: vi.fn() }));
vi.mock("../src/lib/api", () => ({ blobUrl }));

const revoke = vi.fn();

beforeEach(() => {
  blobUrl.mockReset();
  revoke.mockReset();
  vi.stubGlobal("URL", Object.assign(Object.create(URL), URL, { revokeObjectURL: revoke }));
});

const url = () => screen.getByTestId("url").textContent;
const failed = () => screen.getByTestId("failed").textContent;

describe("previewUrl", () => {
  it("exposes the fetched url", async () => {
    blobUrl.mockResolvedValue("blob:x");
    render(PreviewHost, { path: "/api/entry/a/preview" });
    expect(await screen.findByText("blob:x")).toBeTruthy();
    expect(blobUrl).toHaveBeenCalledWith("/api/entry/a/preview");
  });

  it("does not fetch while disabled", () => {
    render(PreviewHost, { path: "/api/entry/a/preview", enabled: false });
    expect(blobUrl).not.toHaveBeenCalled();
    expect(failed()).toBe("false");
  });

  it("reports a failure and leaves no stale url", async () => {
    blobUrl.mockRejectedValue(new Error("boom"));
    render(PreviewHost, { path: "/api/entry/a/preview" });
    expect(await screen.findByText("true")).toBeTruthy();
    expect(url()).toBe("");
  });

  it("revokes a url that arrived before teardown", async () => {
    blobUrl.mockResolvedValue("blob:x");
    const view = render(PreviewHost, { path: "/api/entry/a/preview" });
    await screen.findByText("blob:x");
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("revokes a url that resolves after teardown", async () => {
    // The original bug: the cleanup only revoked when the promise had already resolved, so
    // unmounting mid-load left the whole blob in memory for the rest of the session.
    let release: (value: string) => void = () => {};
    blobUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    );
    const view = render(PreviewHost, { path: "/api/entry/a/preview" });
    view.unmount();
    release("blob:late");
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:late"));
  });

  it("refetches when the path changes", async () => {
    blobUrl.mockResolvedValue("blob:x");
    const view = render(PreviewHost, { path: "/api/entry/a/preview" });
    await screen.findByText("blob:x");
    await view.rerender({ path: "/api/entry/b/preview" });
    expect(blobUrl).toHaveBeenLastCalledWith("/api/entry/b/preview");
  });
});
