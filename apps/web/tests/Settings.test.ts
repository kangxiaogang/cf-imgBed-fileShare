import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSettings, getSystemInfo, putSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getSystemInfo: vi.fn(),
  putSettings: vi.fn(),
}));

/** The typed client is a nested proxy, so the mock mirrors `api.api.settings.$get()` etc. */
vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      settings: { $get: getSettings, $put: putSettings },
      "system-info": { $get: getSystemInfo },
    },
  },
  RequestError: class RequestError extends Error {},
}));
vi.mock("../src/lib/ui.svelte", () => ({ flash: { show: vi.fn(), hide: vi.fn(), value: null } }));

import Settings from "../src/views/Settings.svelte";

beforeEach(() => {
  getSettings.mockReset();
  getSystemInfo.mockReset();
  putSettings.mockReset();
  getSettings.mockResolvedValue({ storeForever: true, defaultDays: 30 });
  getSystemInfo.mockResolvedValue({
    upload_data_bytes: 1024,
    entry_count: 2,
    guest_link_count: 1,
    download_count: 5,
  });
  putSettings.mockResolvedValue({ ok: true });
});

describe("Settings", () => {
  it("renders the fetched values and keeps saving enabled while storing forever", async () => {
    render(Settings);

    // Enabled *once the settings have been read*. Before that it is shut, because the two values
    // it holds are stand-ins until then and submitting them rewrites whatever was configured.
    expect(screen.getByRole("button", { name: "保存设置" })).toBeDisabled();
    const button = await screen.findByRole("button", { name: "保存设置" });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(await screen.findByText("文件数量")).toBeInTheDocument();
    // Storing forever makes the value inert, so the field is gone rather than greyed out.
    expect(screen.queryByLabelText("默认过期天数")).toBeNull();
  });

  it("cannot save settings it never managed to read", async () => {
    // The failure mode this closes: a transient error leaves the form on its placeholder values
    // — keep everything forever, 14 days — with a live save button, one click from writing them
    // over a configured policy.
    getSettings.mockRejectedValue(new Error("网络断了"));
    render(Settings);

    const button = await screen.findByRole("button", { name: "保存设置" });
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(button).toBeDisabled();
    expect(putSettings).not.toHaveBeenCalled();
  });

  it("keeps the settings it read when only the counters fail", async () => {
    // These two were read in one Promise.all, so a failure in the optional panel threw away a
    // settings response that had already arrived. The counters are a report; the policy beside
    // them is not optional, and one must not be able to disarm the other.
    getSettings.mockResolvedValue({ storeForever: false, defaultDays: 7 });
    getSystemInfo.mockRejectedValue(new Error("统计挂了"));
    render(Settings);

    expect(await screen.findByLabelText("默认过期天数")).toHaveValue(7);
    expect(await screen.findByText(/读取失败/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存设置" })).not.toBeDisabled();
  });

  it("reveals the default days once storing forever is unchecked", async () => {
    render(Settings);
    await screen.findByText("文件数量");

    expect(screen.queryByLabelText("默认过期天数")).toBeNull();
    await fireEvent.change(screen.getByRole("checkbox"), { target: { checked: false } });
    expect(screen.getByLabelText("默认过期天数")).toBeInTheDocument();
  });

  it("saves the toggled storeForever setting", async () => {
    render(Settings);
    await screen.findByText("文件数量");

    const button = screen.getByRole("button", { name: "保存设置" });
    await fireEvent.change(screen.getByRole("checkbox"), { target: { checked: false } });
    expect(button).not.toBeDisabled();
    await fireEvent.click(button);

    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith({ json: { storeForever: false, defaultDays: 30 } }),
    );
  });

  it("lets the user change default days when not storing forever", async () => {
    getSettings.mockResolvedValue({ storeForever: false, defaultDays: 7 });
    getSystemInfo.mockResolvedValue({
      upload_data_bytes: 0,
      entry_count: 0,
      guest_link_count: 0,
      download_count: 0,
    });
    render(Settings);
    await screen.findByText("文件数量");

    const button = screen.getByRole("button", { name: "保存设置" });
    const days = screen.getByLabelText("默认过期天数") as HTMLInputElement;
    await fireEvent.input(days, { target: { value: "14" } });
    await fireEvent.click(button);

    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith({ json: { storeForever: false, defaultDays: 14 } }),
    );
  });
});
