<script lang="ts">
  import type { Entry } from "@picoshare/shared";
  import { download } from "../lib/api";
  import { imageLink } from "../lib/format";
  import { previewUrl } from "../lib/preview.svelte";
  import { navigate } from "../lib/router.svelte";
  import CopyLinkButtons from "./CopyLinkButtons.svelte";

  let {
    entry,
    onClose,
    onDelete,
  }: {
    entry: Entry;
    onClose: () => void;
    onDelete: (entry: Entry) => void;
  } = $props();

  // Keyed on the path so navigating to another entry inside the lightbox refetches.
  const preview = previewUrl(() => `/api/entry/${encodeURIComponent(entry.id)}/preview`);

  // Null once every share is revoked: the file is still there, it just cannot be handed out.
  const link = $derived(entry.share_id ? imageLink(entry.share_id, entry.filename) : null);

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }

  /**
   * Read the id before closing, never after.
   *
   * `onClose` clears the parent's `lightbox`, and a `$state` write propagates synchronously, so
   * the very next statement reads an `entry` that is already `null` — `navigate` was handed
   * `undefined` and threw, which left the lightbox closed and the gallery still on screen. That
   * is what 详情 did instead of opening the entry: it did not navigate anywhere.
   */
  function openDetail() {
    const id = entry.id;
    onClose();
    navigate(`/entry/${id}`);
  }
</script>

<!--
  On the window rather than on the dialog: keydown is delivered to `document.activeElement`
  and bubbles through that element's ancestors, and the dialog is a sibling of the gallery
  that opened it. With the listener on the dialog, Escape worked only when something inside
  it happened to hold focus.
-->
<svelte:window onkeydown={onKeydown} />

<div
  class="fixed inset-0 z-30 flex flex-col items-center justify-center bg-slate-900/85 p-4"
  role="dialog"
  aria-modal="true"
  aria-label={entry.filename}
  tabindex="-1"
  onclick={(e) => e.target === e.currentTarget && onClose()}
  onkeydown={onKeydown}
>
  <button class="absolute right-4 top-4 text-xl text-white/80 hover:text-white" onclick={onClose} aria-label="关闭"
    >✕</button
  >
  {#if preview.loading || !preview.url}
    <p class="text-sm text-white/80">加载中…</p>
  {:else if preview.failed}
    <p class="text-sm text-white/80">无法预览</p>
  {:else}
    <img src={preview.url} alt={entry.filename} class="max-h-[70vh] max-w-full rounded-lg bg-white object-contain" />
  {/if}
  <div class="mt-4 flex max-w-3xl flex-wrap items-center justify-center gap-2">
    <span class="max-w-xs truncate text-sm text-white/80">{entry.filename}</span>
    {#if link}
      <CopyLinkButtons url={link} filename={entry.filename} image inverse />
    {/if}
    <button
      class="btn btn-ghost btn-sm bg-white/10 text-white"
      onclick={() => link && void download(link, entry.filename)}>下载</button
    >
    <button
      class="btn btn-ghost btn-sm bg-white/10 text-white"
      onclick={openDetail}>详情</button
    >
    <button class="btn btn-danger btn-sm" onclick={() => onDelete(entry)}>删除</button>
  </div>
</div>
