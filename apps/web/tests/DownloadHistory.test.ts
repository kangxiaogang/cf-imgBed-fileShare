import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDownloads } = vi.hoisted(() => ({ getDownloads: vi.fn() }));

vi.mock("../src/lib/api", () => ({
  api: { api: { entry: { ":id": { downloads: { $get: getDownloads } } } } },
}));

import DownloadHistory from "../src/components/DownloadHistory.svelte";

/**
 * The record was being written; the panel simply never looked again. It re-reads itself when
 * the parent bumps `refreshKey`, which keeps the query in one place instead of duplicating it
 * in the page just to trigger a reload.
 */
const events = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    downloaded_at: `2026-09-2${i}T00:00:00.000Z`,
    ip: `1.1.1.${i}`,
    user_agent: "curl/8",
  }));

beforeEach(() => {
  getDownloads.mockReset();
  getDownloads.mockResolvedValue({ total: 0, events: [] });
});

const mount = async () => {
  const onCount = vi.fn();
  const view = render(DownloadHistory, {
    props: { entryId: "abc123", refreshKey: 0, onCount },
  });
  await waitFor(() => expect(getDownloads).toHaveBeenCalled());
  return { onCount, view };
};

describe("DownloadHistory", () => {
  it("loads once on mount", async () => {
    await mount();
    expect(getDownloads).toHaveBeenCalledTimes(1);
  });

  it("re-reads when the parent bumps refreshKey", async () => {
    const { view } = await mount();
    expect(getDownloads).toHaveBeenCalledTimes(1);

    // What a download does: the record is written, and the key moves.
    await view.rerender({ entryId: "abc123", refreshKey: 1 });

    await waitFor(() => expect(getDownloads).toHaveBeenCalledTimes(2));
  });

  it("shows the refreshed total rather than the one it mounted with", async () => {
    getDownloads.mockResolvedValueOnce({ total: 4, events: events(4) });
    const { view } = await mount();
    expect(await screen.findByText("共 4 条记录")).toBeInTheDocument();

    getDownloads.mockResolvedValue({ total: 5, events: events(5) });
    await view.rerender({ entryId: "abc123", refreshKey: 1 });

    expect(await screen.findByText("共 5 条记录")).toBeInTheDocument();
  });

  it("reports the total back so the page cannot disagree with the panel", async () => {
    getDownloads.mockResolvedValue({ total: 7, events: events(7) });
    const { onCount, view } = await mount();
    await waitFor(() => expect(onCount).toHaveBeenCalledWith(7));

    getDownloads.mockResolvedValue({ total: 8, events: events(8) });
    await view.rerender({ entryId: "abc123", refreshKey: 1 });

    await waitFor(() => expect(onCount).toHaveBeenCalledWith(8));
  });

  it("asks for the grouped view by default", async () => {
    // "How many places fetched this" is the question the panel exists to answer.
    await mount();
    expect(getDownloads.mock.calls[0]?.[0]).toMatchObject({ query: { uniqueIps: "1" } });
  });

  it("re-queries on its own when the grouping is toggled", async () => {
    const { view } = await mount();
    await fireEvent.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(getDownloads).toHaveBeenCalledTimes(2));
    expect(getDownloads.mock.calls[1]?.[0]).toMatchObject({ query: { uniqueIps: "0" } });
  });

  it("does not report a count when the request fails", async () => {
    // The panel is optional; a failure must not also blank the page's own counter.
    getDownloads.mockRejectedValue(new Error("boom"));
    const { onCount } = await mount();
    await waitFor(() => expect(getDownloads).toHaveBeenCalled());
    expect(onCount).not.toHaveBeenCalled();
  });
});
