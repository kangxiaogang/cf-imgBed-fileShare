import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ExpiryDays from "../src/components/ExpiryDays.svelte";

const {
  getEntry,
  getGuestLinks,
  getSettings,
  getShares,
  getVersions,
  postGuestLink,
  postShare,
  putEntry,
  uploadFiles,
} = vi.hoisted(() => ({
  getEntry: vi.fn(),
  getGuestLinks: vi.fn(),
  getSettings: vi.fn(),
  getShares: vi.fn(),
  getVersions: vi.fn(),
  postGuestLink: vi.fn(),
  postShare: vi.fn(),
  putEntry: vi.fn(),
  uploadFiles: vi.fn(),
}));

vi.mock("../src/lib/api", () => ({
  api: {
    api: {
      settings: { $get: getSettings },
      "guest-links": { $get: getGuestLinks, $post: postGuestLink },
      entry: {
        ":id": {
          $get: getEntry,
          $put: putEntry,
          shares: { $get: getShares, $post: postShare },
          versions: { $get: getVersions },
          // The panel below the editor reads this too, and swallows its own failures.
          downloads: { $get: vi.fn().mockResolvedValue({ total: 0, events: [] }) },
        },
      },
    },
  },
  verifySecret: vi.fn(),
  download: vi.fn(),
  openPreview: vi.fn(),
  blobUrl: vi.fn(),
}));
vi.mock("../src/lib/upload", () => ({ uploadFiles, replaceContent: vi.fn() }));
vi.mock("../src/lib/ui.svelte", () => ({
  flash: { show: vi.fn(), hide: vi.fn(), value: null },
  confirmAction: vi.fn().mockResolvedValue(true),
}));

/**
 * 过期天数 was three controls before this one: a `<select>` on the upload form, a tick box and a
 * number box on the entry editor, and a bare nullable number on the guest-link form. Same concept,
 * three state shapes — a `""`-or-digits string, a boolean beside a number, and `number | null` —
 * and a separate conversion in each direction on every page.
 *
 * Three behaviours are worth locking down here, none of them visible in a type check: that the
 * field is one input and not a list competing with it, that the tick box is the only thing
 * distinguishing "expires" from "never expires" — an unchecked box has to mean `null` rather than
 * some default the page then uploads — and that an empty field is read consistently as those two
 * cases differ rather than as one.
 */

/** The label every expiry control carries unless a caller overrides it. */
const DAYS = "过期天数（从今天起）";

describe("ExpiryDays", () => {
  it("is one number field, with no list of durations sitting under it", () => {
    // This went the other way twice. A `<select>` could not hold a value it did not offer, so it
    // needed the current value spliced back into its own options; a `<datalist>` fixed that and
    // put a second list of numbers directly under the field being typed into. Neither earned its
    // place, and this is what stops one creeping back.
    const { container } = render(ExpiryDays, { props: { id: "days" } });

    const field = screen.getByLabelText(DAYS);
    expect(field).toHaveAttribute("type", "number");
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector("datalist")).toBeNull();
    expect(field).not.toHaveAttribute("list");
  });

  it("still states the bound, even though the server is what enforces it", () => {
    // The browser does not stop 9999 being typed and the server now clamps it on both paths, so
    // this is a hint to the reader rather than a limit — but a bound that is not shown is a number
    // the user has no way to know about.
    render(ExpiryDays, { props: { id: "days" } });

    const field = screen.getByLabelText(DAYS);
    expect(field).toHaveAttribute("min", "1");
    expect(field).toHaveAttribute("max", "3650");
  });

  it("reads an empty field as no expiry", async () => {
    render(ExpiryDays, { props: { id: "days", value: null } });

    const field = screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement;
    expect(field.value).toBe("");
    await fireEvent.input(field, { target: { value: "" } });
    expect(field.value).toBe("");
  });

  it("uses the caller's label when the empty state means something else", () => {
    // Guest links: the field bounds how long a file uploaded through the link lives, so "不限"
    // is the right reading of an empty box and "过期天数" would not be.
    render(ExpiryDays, { props: { id: "max-days", value: null, label: "文件保存天数" } });

    expect(screen.getByLabelText("文件保存天数")).toHaveAttribute("placeholder", "不限");
  });

  describe("with the tick box", () => {
    it("keeps the field out of the way while nothing expires", () => {
      render(ExpiryDays, { props: { id: "days", value: null, checkable: true } });

      expect(screen.getByRole("checkbox")).not.toBeChecked();
      expect(screen.queryByLabelText("过期天数（从今天起）")).toBeNull();
    });

    it("prefills when expiry is switched on, so a tick never means zero days", async () => {
      render(ExpiryDays, { props: { id: "days", value: null, checkable: true } });

      await fireEvent.click(screen.getByRole("checkbox"));

      expect(screen.getByRole("checkbox")).toBeChecked();
      // The shared default, which is the same number the settings page's seed row carries and the
      // server falls back to — asserted literally here on purpose, so a change to the constant
      // cannot quietly move this test along with it.
      expect((screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement).value).toBe("14");
    });

    it("prefills with what the caller is configured for, not a constant", async () => {
      // The tick has no history to restore when the field has never held a number, so it falls
      // back. It used to fall back to a literal baked into this component, and the upload form
      // went on to offer that number in place of the days its own settings page was set to.
      render(ExpiryDays, { props: { id: "days", value: null, checkable: true, fallbackDays: 7 } });

      await fireEvent.click(screen.getByRole("checkbox"));

      expect((screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement).value).toBe("7");
    });

    it("picks up a fallback that arrives after it was rendered", async () => {
      // The shape the upload form actually has: the control is on screen before its settings have
      // loaded, so a fallback read at construction was read from null and then frozen in.
      const { rerender } = render(ExpiryDays, { props: { id: "days", value: null, checkable: true } });

      await rerender({ fallbackDays: 21 });
      await fireEvent.click(screen.getByRole("checkbox"));

      expect((screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement).value).toBe("21");
    });

    it("restores an entry's own days rather than the shared default after un-ticking", async () => {
      // The number to restore is whatever the field held, not whatever a caller happens to be
      // configured for: these are two unrelated questions, and an entry with 10 days left must
      // not come back as 14 because that is the upload form's default.
      render(ExpiryDays, { props: { id: "days", value: 10, checkable: true, fallbackDays: 14 } });

      await fireEvent.click(screen.getByRole("checkbox"));
      await fireEvent.click(screen.getByRole("checkbox"));

      expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("10");
    });

    it("reports a change the user made", async () => {
      // What the upload form uses to learn that its configured default may no longer overwrite
      // this field: the response lands a moment after the page is usable, and it cannot tell an
      // untouched field from one the user has already answered.
      const onchange = vi.fn();
      render(ExpiryDays, { props: { id: "days", value: null, checkable: true, onchange } });

      await fireEvent.click(screen.getByRole("checkbox"));

      expect(onchange).toHaveBeenCalledTimes(1);
    });

    it("reports nothing when the digits are cleared, because nothing changed", async () => {
      // With the tick box, clearing the field is a half-typed value rather than a decision — the
      // expiry setting stays as it was. Reporting it would tell the caller the user had answered
      // when they had not, and the default would then be barred from filling in a blank.
      const onchange = vi.fn();
      render(ExpiryDays, { props: { id: "days", value: 45, checkable: true, onchange } });

      await fireEvent.input(screen.getByLabelText("过期天数（从今天起）"), { target: { value: "" } });

      expect(onchange).not.toHaveBeenCalled();
    });

    it("does not let clearing the digits switch expiry off", async () => {
      // Deleting the contents of a number field is a half-typed value, not a decision. If it read
      // as "no expiry" the control would un-tick and remove the field while the cursor is still
      // in it, and a page saved at that moment would silently stop expiring the file.
      render(ExpiryDays, { props: { id: "days", value: 7, checkable: true } });

      await fireEvent.input(screen.getByLabelText("过期天数（从今天起）"), { target: { value: "" } });

      expect(screen.getByRole("checkbox")).toBeChecked();
    });

    it("does let a plain limit field be cleared back to no limit", async () => {
      // The counterpart: with no tick box, an empty field is the only way to remove the limit, so
      // refusing to clear it would leave the limit live behind a field that looks blank.
      render(ExpiryDays, { props: { id: "max-days", value: 7, label: "文件保存天数" } });

      await fireEvent.input(screen.getByLabelText("文件保存天数"), { target: { value: "" } });

      expect((screen.getByLabelText("文件保存天数") as HTMLInputElement).value).toBe("");
    });

    it("keeps a value already set instead of overwriting it", async () => {
      render(ExpiryDays, { props: { id: "days", value: 45, checkable: true } });

      expect((screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement).value).toBe("45");
      // Untick and tick again: 45 was the user's answer, not a default to be discarded.
      await fireEvent.click(screen.getByRole("checkbox"));
      await fireEvent.click(screen.getByRole("checkbox"));
      expect((screen.getByLabelText("过期天数（从今天起）") as HTMLInputElement).value).toBe("45");
    });
  });
});

describe("Upload expiry", () => {
  const mount = async (settings: { storeForever: boolean; defaultDays: number }) => {
    getSettings.mockResolvedValue(settings);
    const { default: Upload } = await import("../src/views/Upload.svelte");
    render(Upload);
    // Wait for the default to be *applied*, not for the request to have been made: the mock
    // resolves on a microtask the view has not necessarily rendered from yet. Which DOM state
    // means "applied" depends on the setting — with expiry on there is a field to find, and with
    // it off there is not, which also fails if the request errored out.
    await waitFor(() => {
      expect(getSettings).toHaveBeenCalled();
      if (settings.storeForever) expect(screen.queryByLabelText(DAYS)).toBeNull();
      else expect(screen.getByLabelText(DAYS)).toBeInTheDocument();
    });
  };

  const upload = async () => {
    await fireEvent.input(screen.getByLabelText("或粘贴文本"), { target: { value: "hello" } });
    await fireEvent.click(screen.getByRole("button", { name: "开始上传" }));
    await waitFor(() => expect(uploadFiles).toHaveBeenCalled());
    return uploadFiles.mock.calls[0][2];
  };

  beforeEach(() => {
    getSettings.mockReset();
    uploadFiles.mockReset();
    uploadFiles.mockResolvedValue([]);
  });

  it("starts with no expiry when settings store forever", async () => {
    await mount({ storeForever: true, defaultDays: 30 });

    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("starts expiring in the configured number of days", async () => {
    await mount({ storeForever: false, defaultDays: 7 });

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("7");
  });

  it("sends a number, not the string the select used to hold", async () => {
    await mount({ storeForever: false, defaultDays: 7 });

    expect(await upload()).toMatchObject({ expirationDays: 7 });
  });

  it("sends no expiry at all when the box is cleared", async () => {
    await mount({ storeForever: false, defaultDays: 7 });
    await fireEvent.click(screen.getByRole("checkbox"));

    expect(await upload()).toMatchObject({ expirationDays: null });
  });

  it("offers the configured days when the box is ticked on a page that starts without expiry", async () => {
    // The configuration that made the disagreement visible. "Keep forever" is on globally, so the
    // form starts unticked — and the settings page *hides* the days field while that box is
    // ticked, so 14 appears nowhere else on screen. The tick used to offer a constant from
    // inside the control instead, so the upload page said 30 and the settings page said 14.
    await mount({ storeForever: true, defaultDays: 14 });

    await fireEvent.click(screen.getByRole("checkbox"));

    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("14");
  });

  it("keeps an answer given before the settings arrived", async () => {
    // The form is usable before its settings load, which is the right trade — gating upload behind
    // a fetch would be worse. But the response then wrote the field unconditionally, so a tick on
    // a fresh page was silently undone a moment later: the box emptied itself and nothing said
    // why. A late write has to know what it is allowed to overwrite.
    let release!: (value: unknown) => void;
    getSettings.mockReturnValue(new Promise((resolve) => (release = resolve)));
    const { default: Upload } = await import("../src/views/Upload.svelte");
    render(Upload);

    await fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("checkbox")).toBeChecked();

    release({ storeForever: true, defaultDays: 14 });
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    // Past the response and the re-render it triggers.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(screen.getByRole("checkbox")).toBeChecked();
    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("14");
  });
});

/**
 * The two views whose save payloads changed shape, neither of which had a test at all before.
 * The pair has to stay in agreement: the server reads `deleteAfterExpiration` to decide whether
 * to look at `expirationDays` at all, so a flag of `true` with no days is a 400 and a flag of
 * `false` with days set is a day count the user never asked for. Two fields standing for one
 * decision is exactly the kind of thing that drifts when a value is renamed.
 */
describe("EntryDetail expiry", () => {
  const detail = (expiration_time: string | null) => ({
    id: "abc123",
    filename: "a.txt",
    content_type: "text/plain",
    size: 10,
    sha256: "",
    version: 1,
    upload_time: "2026-10-01 00:00:00",
    updated_time: "2026-10-01 00:00:00",
    expiration_time,
    note: null,
    download_count: 0,
    share_id: "shr123",
  });

  /** Days from now, as an ISO instant — the server only ever reports an absolute time. */
  const inDays = (days: number) => new Date(Date.now() + days * 86400000).toISOString();

  const mount = async (expiration_time: string | null) => {
    getEntry.mockResolvedValue(detail(expiration_time));
    getVersions.mockResolvedValue({ versions: [] });
    putEntry.mockResolvedValue({ ok: true });
    const { default: EntryDetail } = await import("../src/views/EntryDetail.svelte");
    render(EntryDetail, { props: { id: "abc123" } });
    await screen.findByLabelText("文件名");
  };

  const expiryBox = () => screen.getByRole("checkbox", { name: "设置过期时间" });

  const save = async () => {
    await fireEvent.click(screen.getByRole("button", { name: "保存修改" }));
    await waitFor(() => expect(putEntry).toHaveBeenCalled());
    return putEntry.mock.calls[0][0].json;
  };

  beforeEach(() => {
    getEntry.mockReset();
    getShares.mockReset();
    getVersions.mockReset();
    putEntry.mockReset();
    postShare.mockReset();
    // The detail page loads the share list alongside the entry; an unresolved promise here is a
    // rejection inside a `Promise.all`, which surfaces as the load error rather than a timeout.
    getShares.mockResolvedValue([]);
  });

  it("offers the remaining days for an entry that already expires", async () => {
    await mount(inDays(10));

    expect(expiryBox()).toBeChecked();
    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("10");
  });

  it("sends the flag and the days together", async () => {
    await mount(inDays(10));

    expect(await save()).toMatchObject({ expirationDays: 10, deleteAfterExpiration: true });
  });

  it("clears both halves of the decision when the box is unticked", async () => {
    await mount(inDays(10));
    await fireEvent.click(expiryBox());

    // Not `expirationDays: null` alongside a false flag: the two must read as one decision, and
    // a days value left behind would be re-applied the moment the box is ticked again.
    expect(await save()).toMatchObject({ expirationDays: 0, deleteAfterExpiration: false });
  });

  it("does not lose the typed days when the box is unticked and ticked again", async () => {
    await mount(inDays(10));
    await fireEvent.input(screen.getByLabelText(DAYS), { target: { value: "45" } });
    await fireEvent.click(expiryBox());
    await fireEvent.click(expiryBox());

    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("45");
    expect(await save()).toMatchObject({ expirationDays: 45, deleteAfterExpiration: true });
  });

  it("clamps an entry that has already expired up to a day rather than to zero", async () => {
    await mount(inDays(-5));

    // Zero days would make the box claim to expire a file that is already gone, and the server
    // rejects a non-positive count outright.
    expect(expiryBox()).toBeChecked();
    expect((screen.getByLabelText(DAYS) as HTMLInputElement).value).toBe("1");
  });
});

describe("GuestLinks expiry", () => {
  const mount = async () => {
    getGuestLinks.mockResolvedValue([]);
    postGuestLink.mockResolvedValue({ ok: true });
    const { default: GuestLinks } = await import("../src/views/GuestLinks.svelte");
    render(GuestLinks);
    await screen.findByLabelText("文件保存天数");
  };

  const create = async () => {
    await fireEvent.click(screen.getByRole("button", { name: "创建链接" }));
    await waitFor(() => expect(postGuestLink).toHaveBeenCalled());
    return postGuestLink.mock.calls[0][0].json;
  };

  beforeEach(() => {
    getGuestLinks.mockReset();
    postGuestLink.mockReset();
  });

  it("keeps the guest-link wording, which is not the same question", async () => {
    await mount();

    // "文件保存天数" bounds how long a file uploaded *through this link* lives. Reading it as
    // "过期天数" would say the link itself expires, which is what 链接失效日期 is for.
    expect(screen.getByLabelText("文件保存天数")).toHaveAttribute("placeholder", "不限");
  });

  it("sends no limit when the field is left empty", async () => {
    await mount();

    expect(await create()).toMatchObject({ max_file_lifetime_days: null });
  });

  it("sends the number that was typed", async () => {
    await mount();
    await fireEvent.input(screen.getByLabelText("文件保存天数"), { target: { value: "3" } });

    expect(await create()).toMatchObject({ max_file_lifetime_days: 3 });
  });
});
