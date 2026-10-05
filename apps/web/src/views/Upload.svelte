<script lang="ts">
  import { DEFAULT_EXPIRATION_DAYS } from "@picoshare/shared";
  import { errorMessage } from "../lib/errors";
  import { onMount } from "svelte";
  import CopyLinkButtons from "../components/CopyLinkButtons.svelte";
  import ExpiryDays from "../components/ExpiryDays.svelte";
  import FilePicker from "../components/FilePicker.svelte";
  import { api } from "../lib/api";
  import { copyWithFlash } from "../lib/clipboard";
  import { navigate, route } from "../lib/router.svelte";
  import { flash } from "../lib/ui.svelte";
  import { uploadFiles, type UploadItem } from "../lib/upload";

  let files = $state<File[]>([]);
  let text = $state("");
  let note = $state("");
  let expiration = $state<number | null>(null);
  /**
   * Set the moment the expiry control is used, so the configured default arriving a moment later
   * cannot undo the answer the user has already given.
   *
   * It could, and did. The form is deliberately usable before its settings have loaded — gating
   * upload behind a fetch would be a worse trade — so a tick on a fresh page was silently undone
   * by the response a moment later, leaving the box unticked and nothing explaining why. A late
   * write has to know what it is allowed to overwrite.
   */
  let expirationTouched = $state(false);
  /** The configured default, so a tick with no history of its own restores this and not a constant. */
  let defaultDays = $state(DEFAULT_EXPIRATION_DAYS);
  let busy = $state(false);
  let percent = $state(0);
  let results = $state<UploadItem[]>([]);
  let resultsMode = $state<"file" | "image">("file");
  type UploadMode = "file" | "image";

  const modeFromUrl = (): UploadMode => (route.query.get("mode") === "image" ? "image" : "file");

  let mode: UploadMode = $state(modeFromUrl());
  let error = $state("");

  onMount(() => {
    void (async () => {
      try {
        const settings = await api.api.settings.$get();
        defaultDays = settings.defaultDays;
        if (!expirationTouched) {
          expiration = settings.storeForever ? null : settings.defaultDays;
        }
      } catch {
        // keep the default (permanent)
      }
    })();
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  });

  const ready = $derived(files.length > 0 || text.trim().length > 0);
  const dedupedCount = $derived(results.filter((item) => item.deduped).length);
  // Only the images among the results have a link, so joining `url` directly would copy an empty
  // line per file and, with no images at all, copy a blank string while reporting success.
  const resultUrls = $derived(results.flatMap((item) => (item.url ? [item.url] : [])));

  // The URL is the source of truth, so the back button and a pasted `?mode=image` both land
  // on the right tab. A screenshot pasted in image mode is also not a valid file-mode
  // selection, and keeping it would upload it under the wrong rules, so a change drops the
  // half-made one. The write re-runs this effect, where the comparison then holds.
  $effect(() => {
    const wanted = modeFromUrl();
    if (wanted === mode) return;
    mode = wanted;
    files = [];
    text = "";
  });

  function switchMode(next: UploadMode) {
    navigate(next === "image" ? "/upload?mode=image" : "/upload");
  }

  function onPaste(event: ClipboardEvent) {
    if (mode !== "image" || busy) return;
    const items = event.clipboardData?.items;
    if (!items) return;
    const picked: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = (blob.type.split("/")[1] || "png").replace("jpeg", "jpg");
      picked.push(
        new File([blob], `paste-${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`, { type: blob.type }),
      );
    }
    if (!picked.length) return;
    event.preventDefault();
    files = [...files, ...picked];
    flash.show(`已粘贴 ${picked.length} 张截图`);
  }

  async function submit() {
    if (!ready || busy) return;
    busy = true;
    error = "";
    percent = 0;
    try {
      resultsMode = mode;
      results = await uploadFiles(files, mode === "image" ? "" : text, {
        expirationDays: expiration,
        note: note.trim() || null,
        onProgress: (value) => (percent = value),
      });
      files = [];
      text = "";
      note = "";
      flash.show(
        dedupedCount
          ? `已上传 ${results.length} 个文件，其中 ${dedupedCount} 张为已存在的相同图片，已复用已存储的内容（备注与有效期未应用）`
          : `已上传 ${results.length} 个文件`,
      );
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  const modeTab = (active: boolean) =>
    `rounded-lg px-3 py-1.5 text-sm font-medium ${active ? "bg-sky-50 text-sky-700" : "text-slate-600 hover:bg-slate-100"}`;
</script>

<h1 class="mb-4 text-lg font-semibold text-slate-800">上传</h1>

<div class="mb-4 flex gap-1 border-b border-slate-200">
  <button class={modeTab(mode === "file")} onclick={() => switchMode("file")}>文件</button>
  <button class={modeTab(mode === "image")} onclick={() => switchMode("image")}>图片</button>
</div>

<div class="grid gap-4 lg:grid-cols-[1fr_260px]">
  <div class="card">
    <FilePicker
      bind:files
      bind:text
      imageOnly={mode === "image"}
      hint={mode === "image"
        ? "支持拖拽、点击选择，或在页面任意位置粘贴截图（Ctrl+V）"
        : "支持拖拽、点击选择或多选文件"}
    />
    <div class="mt-4 flex items-center gap-3">
      <button class="btn btn-primary" disabled={!ready || busy} onclick={submit}>
        {busy ? "上传中…" : "开始上传"}
      </button>
      {#if busy}
        <div class="flex-1">
          <div class="h-2 w-full rounded-full bg-slate-100">
            <div class="h-2 rounded-full bg-sky-600 transition-all" style="width: {percent}%"></div>
          </div>
          <p class="hint">{percent >= 100 ? "服务器处理中…" : `${percent}%`}</p>
        </div>
      {/if}
    </div>
    {#if error}
      <p class="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>
    {/if}
  </div>

  <div class="card h-fit">
    <h2 class="card-title">上传选项</h2>
    <label class="label" for="note">备注</label>
    <input id="note" class="input" maxlength="1000" bind:value={note} placeholder="可选" />
    <ExpiryDays
      id="expiration"
      bind:value={expiration}
      fallbackDays={defaultDays}
      onchange={() => (expirationTouched = true)}
      checkable
    />
    <p class="hint">超过 100MB 的文件会自动分片上传。已粘贴文本会作为独立文件上传。</p>
    {#if mode === "image"}
      <p class="hint">相同图片（按 SHA-256 判定）不会重复存储，但会生成各自的分享链接。</p>
    {/if}
  </div>
</div>

{#if results.length}
  <div class="card mt-4">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="card-title mb-0">上传完成</h2>
      <button
        class="btn btn-ghost btn-sm"
        disabled={!resultUrls.length}
        onclick={() => void copyWithFlash(resultUrls.join("\n"), "全部链接已复制")}
        >复制全部链接</button
      >
    </div>
    {#if dedupedCount}
      <p class="hint mb-3">
        {dedupedCount} 张图片内容已存在，已复用已存储的内容；这些文件的备注与有效期设置未生效。
      </p>
    {/if}
    <ul class="space-y-2">
      {#each results as item, i (item.id + "-" + i)}
        <li class="rounded-lg border border-slate-200 px-3 py-2">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="truncate text-sm font-medium text-slate-700">
              {item.filename}
              {#if item.deduped}<span class="chip ml-1">已存在</span>{/if}
            </span>
            <span class="flex items-center gap-2">
              {#if item.url}
                <code class="truncate rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{item.url}</code>
                <button class="btn btn-ghost btn-sm" onclick={() => void copyWithFlash(item.url!, "链接已复制")}
                  >复制</button
                >
              {:else}
                <!-- A file is not public until it is shared, so there is no link to hand out
                     yet. Saying so beats an empty code block. -->
                <span class="text-xs text-slate-500">未分享</span>
              {/if}
              <button class="btn btn-ghost btn-sm" onclick={() => navigate(`/entry/${item.id}`)}>详情</button>
            </span>
          </div>
          {#if resultsMode === "image" && item.url}
            <div class="mt-2">
              <CopyLinkButtons url={item.url} filename={item.filename} image />
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{/if}
