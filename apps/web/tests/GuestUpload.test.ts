import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GuestInfo } from "@picoshare/shared";

const { getGuestInfo, guestUpload } = vi.hoisted(() => ({
  getGuestInfo: vi.fn(),
  guestUpload: vi.fn(),
}));

/** The typed client is a nested proxy, so the mock mirrors `api.api.guest[":id"].info.$get()`. */
vi.mock("../src/lib/api", () => ({
  api: { api: { guest: { ":id": { info: { $get: getGuestInfo } } } } },
  RequestError: class extends Error {},
}));
vi.mock("../src/lib/upload", () => ({ guestUpload }));

import GuestUpload from "../src/views/GuestUpload.svelte";

const info = (overrides: Partial<GuestInfo> = {}): GuestInfo => ({
  max_file_bytes: 1024 * 1024,
  max_file_lifetime_days: 7,
  max_file_uploads: 3,
  remaining_uploads: 2,
  max_files: 20,
  url_expires: "2026-12-31T00:00:00.000Z",
  ...overrides,
});

beforeEach(() => {
  getGuestInfo.mockReset();
  guestUpload.mockReset();
  getGuestInfo.mockResolvedValue(info());
});

describe("GuestUpload", () => {
  /**
   * The endpoint used to answer with camelCase (`maxFileBytes`) while this view read
   * snake_case off a `GuestLink`. Nothing reported it: `api.get<GuestLink>` is an unchecked
   * assertion, so every field was `undefined` and the page rendered "大小不限" for a cap that
   * was being enforced on the server, plus a permanently "unlimited" quota. These assertions
   * read the exact keys the server now sends.
   */
  it("renders the real limits instead of falling through to unlimited", async () => {
    render(GuestUpload, { props: { id: "g1" } });

    expect(await screen.findByText("单文件 ≤ 1.0 MB")).toBeInTheDocument();
    expect(screen.getByText("还可上传 2/3 次")).toBeInTheDocument();
    expect(screen.getByText("文件 7 天后过期")).toBeInTheDocument();
    expect(screen.getByText("链接 2026-12-31 失效")).toBeInTheDocument();
    expect(screen.queryByText("大小不限")).toBeNull();
    expect(screen.queryByText("上传次数不限")).toBeNull();
  });

  it("shows a fixed title because the creator's label is not disclosed", async () => {
    render(GuestUpload, { props: { id: "g1" } });

    expect(await screen.findByRole("heading", { name: "访客上传" })).toBeInTheDocument();
  });

  it("always shows the per-file cap, because the server never stores an uncapped one", async () => {
    // `max_file_bytes` is NOT NULL with a real default, so "unlimited" is not a state the
    // endpoint can report. The field used to render as "大小不限" for a cap that was being
    // enforced, which is the exact mismatch this test pins down.
    getGuestInfo.mockResolvedValue(
      info({ max_file_uploads: null, remaining_uploads: null, max_file_lifetime_days: null }),
    );
    render(GuestUpload, { props: { id: "g1" } });

    expect(await screen.findByText("单文件 ≤ 1.0 MB")).toBeInTheDocument();
    expect(screen.queryByText("大小不限")).toBeNull();
    expect(screen.getByText("上传次数不限")).toBeInTheDocument();
    expect(screen.getByText("文件不过期")).toBeInTheDocument();
  });

  it("blocks the form once the quota is spent", async () => {
    getGuestInfo.mockResolvedValue(info({ remaining_uploads: 0 }));
    render(GuestUpload, { props: { id: "g1" } });

    expect(await screen.findByText("该链接的上传次数已用完，请联系链接创建者。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "上传" })).toBeNull();
  });

  it("decrements the remaining quota locally after an upload", async () => {
    guestUpload.mockResolvedValue({
      count: 2,
      items: [
        {
          id: "e1",
          filename: "a.png",
          version: 1,
          sha256: null,
          url: "https://example.com/-e1",
          markdown: "",
          bbcode: "",
          contentType: "image/png",
        },
        {
          id: "e2",
          filename: "b.png",
          version: 1,
          sha256: null,
          url: "https://example.com/-e2",
          markdown: "",
          bbcode: "",
          contentType: "image/png",
        },
      ],
      upload_count: 3,
      deduped: 0,
    });

    render(GuestUpload, { props: { id: "g1" } });
    await screen.findByText("还可上传 2/3 次");

    await fireEvent.input(screen.getByLabelText("或粘贴文本"), { target: { value: "hello" } });
    await fireEvent.click(screen.getByRole("button", { name: "上传" }));

    await waitFor(() => expect(screen.getByText("已上传 2 个文件")).toBeInTheDocument());
    // 2 remaining minus the 2 files just uploaded.
    expect(screen.getByText("该链接还可上传 0 次")).toBeInTheDocument();
    expect(screen.getByText("还可上传 0/3 次")).toBeInTheDocument();
  });

  it("leaves an unlimited quota unlimited after uploading", async () => {
    getGuestInfo.mockResolvedValue(info({ max_file_uploads: null, remaining_uploads: null }));
    guestUpload.mockResolvedValue({
      count: 1,
      items: [
        {
          id: "e1",
          filename: "a.png",
          version: 1,
          sha256: null,
          url: "https://example.com/-e1",
          markdown: "",
          bbcode: "",
          contentType: "image/png",
        },
      ],
      upload_count: 1,
      deduped: 0,
    });

    render(GuestUpload, { props: { id: "g1" } });
    await screen.findByText("上传次数不限");

    await fireEvent.input(screen.getByLabelText("或粘贴文本"), { target: { value: "hello" } });
    await fireEvent.click(screen.getByRole("button", { name: "上传" }));

    await waitFor(() => expect(screen.getByText("已上传 1 个文件")).toBeInTheDocument());
    expect(screen.getByText("上传次数不限")).toBeInTheDocument();
  });
});