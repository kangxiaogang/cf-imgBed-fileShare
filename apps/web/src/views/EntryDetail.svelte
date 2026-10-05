<script lang="ts">
  import { errorMessage } from "../lib/errors";
  import type { EntryDetailResponse, FileVersion } from "@picoshare/shared";
  import { isImageContentType, isInlineSafe } from "@picoshare/shared";
  import { onMount } from "svelte";
  import DownloadHistory from "../components/DownloadHistory.svelte";
  import ShareManager from "../components/ShareManager.svelte";
  import ExpiryDays from "../components/ExpiryDays.svelte";
  import EntryPreview from "../components/EntryPreview.svelte";
  import VersionTable from "../components/VersionTable.svelte";
  import { api, download, openPreview } from "../lib/api";
  import { copyWithFlash } from "../lib/clipboard";
  import { formatBytes, formatDate, shortLink } from "../lib/format";
  import { navigate } from "../lib/router.svelte";
  import { confirmAction, flash } from "../lib/ui.svelte";
  import { replaceContent } from "../lib/upload";

  let { id }: { id: string } = $props();

  let entry = $state<EntryDetailResponse | null>(null);
  let versions = $state<FileVersion[]>([]);
  let loading = $state(true);
  let loadError = $state("");

  let filename = $state("");
  let note = $state("");
  let expiration = $state<number | null>(null);

  let saving = $state(false);
  // Bumped after a download so the record below re-reads itself. Separate from the entry
  // because re-running `load()` would overwrite the edit form with the server's values —
  // a download should not discard a half-typed filename.
  let downloads = $state(0);
  let replacing = $state(false);
  let replacePercent = $state(0);
  let fileInput: HTMLInputElement | undefined = $state();
  let managing = $state(false);

  // How many links are still usable, so the summary can say something. Creating, renaming and
  // revoking all live on the entry's share page; this view only reports what is left of them.
  let liveShares = $state(0);

  onMount(() => {
    void load();
  });

  async function load() {
    try {
      const [detail, versionList, shareList] = await Promise.all([
        api.api.entry[":id"].$get({ param: { id } }),
        api.api.entry[":id"].versions.$get({ param: { id } }),
        api.api.entry[":id"].shares.$get({ param: { id } }),
      ]);
      entry = detail;
      versions = versionList.versions;
      liveShares = shareList.filter((share) => !share.expires_at || Date.parse(share.expires_at) > Date.now()).length;
      filename = detail.filename;
      note = detail.note ?? "";
      expiration = detail.expiration_time
        ? Math.max(1, Math.ceil((Date.parse(detail.expiration_time) - Date.now()) / 86400000))
        : null;
    } catch (err) {
      loadError = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  /** The link this entry currently hands out, or null once every share is gone. */
  const shareLink = $derived(entry?.share_id ? shortLink(entry.share_id) : null);

  /**
   * Saves the current version, by whichever of two routes applies.
   *
   * With a share, through the public link: the same route any visitor would use, and the one that
   * records, so the count reflects the file being handed out. Without one there is no public link
   * at all, and the owner's own authenticated route serves the bytes instead — the file is still
   * theirs to take, and minting a share just to log their own save would leave behind a public
   * link nobody asked for. Nothing is recorded on that path, which is the point: the history
   * answers "has this been crawled", not "have I opened it myself".
   */
  async function saveFile() {
    if (!entry) return;
    const name = entry.filename || id;
    if (shareLink) {
      await download(shareLink, name);
      downloads += 1;
      return;
    }
    await download(`/api/entry/${encodeURIComponent(id)}/versions/${entry.version}/content`, name);
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!entry) return;
    saving = true;
    try {
      await api.api.entry[":id"].$put({
        param: { id },
        json: {
          filename: filename.trim() || entry.filename,
          note: note.trim(),
          expirationDays: expiration ?? 0,
          deleteAfterExpiration: expiration !== null,
        },
      });
      flash.show("已保存");
      loading = true;
      await load();
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      saving = false;
    }
  }

  async function onReplaceFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !entry) return;
    if (file.name !== entry.filename) {
      flash.show("替换文件必须保持相同文件名", "error");
      return;
    }
    replacing = true;
    replacePercent = 0;
    try {
      const result = await replaceContent(id, entry.version, file, (value) => (replacePercent = value));
      flash.show(`已更新到版本 ${result.version}`);
      loading = true;
      await load();
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      replacing = false;
    }
  }

  async function removeVersion(version: number) {
    if (!(await confirmAction(`确定删除版本 ${version} 吗？`))) return;
    try {
      await api.api.entry[":id"].versions[":version"].$delete({ param: { id, version: String(version) } });
      versions = versions.filter((item) => item.version !== version);
      flash.show("版本已删除");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  async function remove() {
    if (!entry) return;
    if (!(await confirmAction(`确定删除「${entry.filename}」吗？此操作不可恢复。`))) return;
    try {
      await api.api.entry[":id"].$delete({ param: { id } });
      flash.show("已删除");
      navigate("/");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  const canPreview = $derived(entry ? isInlineSafe(entry.content_type) : false);

  const meta = $derived(
    entry
      ? [
          { label: "大小", value: formatBytes(entry.size) },
          { label: "版本", value: String(entry.version) },
          { label: "上传时间", value: formatDate(entry.upload_time) },
          { label: "更新时间", value: formatDate(entry.updated_time) },
          { label: "过期时间", value: entry.expiration_time ? formatDate(entry.expiration_time) : "永久" },
          { label: "下载次数", value: String(entry.download_count) },
        ]
      : [],
  );
</script>

{#if loading && !entry}
  <p class="text-sm text-slate-500">加载中…</p>
{:else if loadError && !entry}
  <div class="card border-rose-200 bg-rose-50 text-sm text-rose-700">{loadError}</div>
{:else if entry}
  <div class="mb-4 flex flex-wrap items-center gap-3">
    <button class="btn btn-ghost btn-sm" onclick={() => navigate("/")}>← 返回</button>
    <h1 class="truncate text-lg font-semibold text-slate-800">{entry.filename}</h1>
    <button class="btn btn-ghost btn-sm" onclick={() => void saveFile()}>下载</button>
    {#if canPreview}
      <button
        class="btn btn-ghost btn-sm"
        onclick={() => void openPreview(`/api/entry/${encodeURIComponent(id)}/preview`)}>预览</button
      >
    {/if}
    <button class="btn btn-danger btn-sm" onclick={remove}>删除</button>
  </div>

  {#if isImageContentType(entry.content_type)}
    <EntryPreview {entry} />
  {/if}

  <div class="grid gap-4 lg:grid-cols-2">
    <div class="card">
      <h2 class="card-title">基本信息</h2>
      <dl class="grid grid-cols-2 gap-3">
        {#each meta as item (item.label)}
          <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <dt class="text-xs text-slate-500">{item.label}</dt>
            <dd class="text-sm font-semibold text-slate-800">{item.value}</dd>
          </div>
        {/each}
      </dl>
      <div class="mt-3">
        <p class="text-xs text-slate-500">SHA-256</p>
        <code class="mt-1 block break-all rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">
          {entry.sha256 || "未计算（大文件或旧数据）"}
        </code>
        {#if entry.sha256}
          <button
            class="btn btn-ghost btn-sm mt-2"
            onclick={() => void copyWithFlash(entry?.sha256 || "", "校验值已复制")}>复制校验值</button
          >
        {/if}
      </div>
    </div>

    <form class="card" onsubmit={save}>
      <h2 class="card-title">编辑</h2>
      <label class="label" for="entry-filename">文件名</label>
      <input id="entry-filename" class="input" maxlength="255" bind:value={filename} />
      <label class="label mt-3" for="entry-note">备注</label>
      <input id="entry-note" class="input" maxlength="1000" bind:value={note} placeholder="可选" />
      <ExpiryDays id="entry-days" bind:value={expiration} checkable />
      <div class="mt-4 flex items-center gap-2">
        <button class="btn btn-primary" type="submit" disabled={saving}>{saving ? "保存中…" : "保存修改"}</button>
        <button class="btn btn-ghost" type="button" onclick={() => fileInput?.click()} disabled={replacing}>
          {replacing ? `替换中 ${replacePercent}%` : "替换文件"}
        </button>
      </div>
      <p class="hint">替换后历史版本仍可查看与下载。</p>
      <input class="hidden" type="file" bind:this={fileInput} onchange={(e) => void onReplaceFile(e)} />
    </form>
  </div>

  <VersionTable entryId={id} {versions} currentVersion={entry.version} onDelete={removeVersion} />

  <!--
    A summary, not the management: what belongs here is whether the file can be handed out at
    all. Creating, renaming, expiring and revoking happen in the dialog this button opens, and
    every link there has its own copy button — with several links a single "copy the link" would
    have no single referent.
  -->
  <div class="card">
    <div class="flex flex-wrap items-center gap-2">
      <h2 class="card-title mb-0">分享链接</h2>
      {#if liveShares}
        <span class="chip">{liveShares} 条可用</span>
      {:else}
        <span class="chip">未分享</span>
      {/if}
      <button class="btn btn-ghost btn-sm ml-auto" onclick={() => (managing = true)}
        >分享管理</button
      >
    </div>
    <p class="hint mt-2">
      {#if liveShares}
        撤销或过期链接都不会删除文件，随时可以再创建一个。
      {:else}
        还没有可用的分享链接。别人无法通过链接下载这个文件，但文件本身完好无损。
      {/if}
    </p>
  </div>

  <DownloadHistory
    entryId={id}
    refreshKey={downloads}
    onCount={(n) => {
      if (entry) entry = { ...entry, download_count: n };
    }}
  />
{/if}

{#if managing}
  <!-- The same dialog the list opens, so the two entry points cannot drift apart. Closing it
       re-reads the entry: the dialog creates and revokes shares, and the summary above reports
       what is left of them, so without this the page would still say 未分享 after one was made. -->
  <ShareManager
    entryId={id}
    filename={entry?.filename ?? ""}
    onClose={() => {
      managing = false;
      void load();
    }}
  />
{/if}
