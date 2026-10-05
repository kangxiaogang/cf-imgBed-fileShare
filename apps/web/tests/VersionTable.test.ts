import type { FileVersion } from "@picoshare/shared";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import VersionTable from "../src/components/VersionTable.svelte";

const version = (value: number): FileVersion => ({
  entry_id: "abc",
  version: value,
  filename: "a.txt",
  content_type: "text/plain",
  size: value * 100,
  sha256: null,
  created_time: "2026-09-26T00:00:00.000Z",
});

describe("VersionTable", () => {
  it("marks the current version and only offers deletion for others", async () => {
    const onDelete = vi.fn();
    render(VersionTable, {
      props: { entryId: "abc", versions: [version(2), version(1)], currentVersion: 2, onDelete },
    });

    expect(screen.getByText("当前")).toBeInTheDocument();
    const deleteButtons = screen.getAllByText("删除");
    expect(deleteButtons).toHaveLength(1);

    await fireEvent.click(deleteButtons[0]);
    expect(onDelete).toHaveBeenCalledWith(1);
  });

  it("renders every version row", () => {
    render(VersionTable, {
      props: { entryId: "abc", versions: [version(2), version(1)], currentVersion: 2, onDelete: vi.fn() },
    });

    expect(screen.getAllByText("下载")).toHaveLength(2);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });
});
