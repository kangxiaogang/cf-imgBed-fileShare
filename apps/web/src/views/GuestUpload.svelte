<script lang="ts">
  import { errorMessage } from "../lib/errors";
  import type { GuestInfo, GuestUploadResponse } from "@picoshare/shared";
  import { onMount } from "svelte";
  import FilePicker from "../components/FilePicker.svelte";
  import { api } from "../lib/api";
  import { copyText } from "../lib/clipboard";
  import { formatBytes } from "../lib/format";
  import { guestUpload } from "../lib/upload";

  let { id }: { id: string } = $props();

  let link = $state<GuestInfo | null>(null);
  let loadError = $state("");
  let files = $state<File[]>([]);
  let text = $state("");
  let note = $state("");
  let busy = $state(false);
  let percent = $state(0);
  let error = $state("");
  let uploaded = $state<GuestUploadResponse | null>(null);

  onMount(() => {
    void load();
  });

  async function load() {
    try {
      link = await api.api.guest[":id"].info.$get({ param: { id } });
    } catch (err) {
      loadError = errorMessage(err);
    }
  }

  // The server sends what is left rather than the raw counter, so the quota cannot be
  // rendered optimistically wrong between loads.
  const uploadsLeft = $derived(link?.remaining_uploads ?? null);
  const limitReached = $derived(uploadsLeft !== null && uploadsLeft <= 0);
  const ready = $derived(!limitReached && (files.length > 0 || text.trim().length > 0));

  async function submit() {
    if (!ready || busy || !link) return;
    busy = true;
    error = "";
    percent = 0;
    try {
      uploaded = await guestUpload(id, files, text, note.trim(), (value) => (percent = value));
      // The response carries the server's own counter, so derive what is left from it rather
      // than subtracting locally: the reserve also bumps uncapped links, and a retried or
      // partially rejected request would make a local subtraction drift from the truth.
      if (link.max_file_uploads !== null) {
        link.remaining_uploads = Math.max(0, link.max_file_uploads - uploaded.upload_count);
      }
      files = [];
      text = "";
      note = "";
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  async function copyUrl(url: string) {
    const ok = await copyText(url);
    if (!ok) error = "复制失败，请手动复制";
  }
</script>

<div class="mx-auto max-w-2xl px-4 py-10">
  <div class="mb-5 flex items-center gap-2">
    <span class="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-600 text-xs font-bold text-white">P</span>
    <span class="font-semibold text-slate-800">PicoShare</span>
  </div>

  {#if loadError}
    <div class="card border-rose-200 bg-rose-50 text-sm text-rose-700">{loadError}</div>
  {:else if !link}
    <div class="card text-sm text-slate-500">加载中…</div>
  {:else}
    <div class="card">
      <!-- Fixed title: `label` is the creator's private note and is not sent to guests. -->
      <h1 class="card-title">访客上传</h1>
      <p class="mb-3 text-sm text-slate-500">无需登录即可上传文件，上传后会立即生成分享链接。</p>

      <div class="mb-4 flex flex-wrap gap-2">
        <span class="chip">单文件 ≤ {formatBytes(link.max_file_bytes)}</span>
<span class="chip">
          {link.max_file_uploads !== null
            ? `还可上传 ${link.remaining_uploads ?? 0}/${link.max_file_uploads} 次`
            : "上传次数不限"}
        </span>
        <span class="chip">
          {link.max_file_lifetime_days ? `文件 ${link.max_file_lifetime_days} 天后过期` : "文件不过期"}
        </span>
        <span class="chip">单次最多 {link.max_files} 个文件</span>
        {#if link.url_expires}
          <span class="chip">链接 {link.url_expires.slice(0, 10)} 失效</span>
        {/if}
      </div>

      {#if limitReached}
        <p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          该链接的上传次数已用完，请联系链接创建者。
        </p>
      {:else}
        <FilePicker bind:files bind:text maxFiles={link.max_files} hint={`单个文件建议小于 ${formatBytes(link.max_file_bytes)}`} />

        <label class="label mt-4" for="guest-note">备注</label>
        <input
          id="guest-note"
          class="input"
          maxlength="1000"
          bind:value={note}
          placeholder="可选，只有你（链接创建者）能看到"
        />

        <div class="mt-4 flex items-center gap-3">
          <button class="btn btn-primary" disabled={!ready || busy} onclick={submit}>
            {busy ? "上传中…" : "上传"}
          </button>
          {#if busy}
            <div class="flex-1">
              <div class="h-2 w-full rounded-full bg-slate-100">
                <div class="h-2 rounded-full bg-sky-600 transition-all" style="width: {percent}%"></div>
              </div>
            </div>
          {/if}
        </div>
      {/if}

      {#if error}
        <p class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
      {/if}
    </div>

    {#if uploaded}
      <div class="card mt-4 border-emerald-200">
        <h2 class="card-title">已上传 {uploaded.count} 个文件</h2>
        {#if uploaded.deduped}
          <p class="hint mb-2">{uploaded.deduped} 个为已存在的相同图片，复用了已存储的内容。</p>
        {/if}
        <ul class="space-y-2">
          {#each uploaded.items as item (item.id + item.filename)}
            <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              {#if item.url}
                <code class="truncate text-xs text-slate-600">{item.url}</code>
              {:else}
                <!-- A guest has no account and so cannot share anything; a file they send is
                     not public until its owner decides to make a link for it. -->
                <span class="text-xs text-slate-500">{item.filename}</span>
              {/if}
              <span class="flex gap-2">
                {#if item.url}
                  <button class="btn btn-ghost btn-sm" onclick={() => void copyUrl(item.url!)}>复制</button>
                {/if}
                {#if item.url && item.contentType.startsWith("image/")}
                  <button class="btn btn-ghost btn-sm" onclick={() => void copyUrl(item.markdown!)}>Markdown</button>
                  <button class="btn btn-ghost btn-sm" onclick={() => void copyUrl(item.bbcode!)}>BBCode</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
        {#if link.remaining_uploads !== null}
          <p class="hint mt-3">该链接还可上传 {link.remaining_uploads} 次</p>
        {/if}
      </div>
    {/if}
  {/if}
</div>
