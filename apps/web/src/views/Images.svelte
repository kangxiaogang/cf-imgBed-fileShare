<script lang="ts">
  import type { EntryListItem } from "@picoshare/shared";
  import { onMount } from "svelte";
  import ImageViewer from "../components/ImageViewer.svelte";
  import Thumb from "../components/Thumb.svelte";
  import { entryActions } from "../lib/entryActions.svelte";
  import { formatBytes } from "../lib/format";
  import { pagedList } from "../lib/pagedList.svelte";
  import { navigate } from "../lib/router.svelte";
  import { selection } from "../lib/selection.svelte";

  const list = pagedList({ kind: "image" });
  const sel = selection(() => list.items);
  let query = $state("");
  let lightbox = $state<EntryListItem | null>(null);
  const actions = entryActions({
    list,
    selection: sel,
    noun: "张图片",
    onDeleted: (ids) => {
      if (lightbox && ids.includes(lightbox.id)) lightbox = null;
    },
  });

  onMount(() => {
    void list.load(true);
    return () => list.dispose();
  });

  function onSearch(value: string) {
    // Ids from the previous result set are still selected but no longer on screen, so a bulk
    // delete would remove images the user cannot see.
    sel.clear();
    list.onSearch(value);
  }
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
  <h1 class="text-lg font-semibold text-slate-800">图片</h1>
  <span class="chip">{list.items.length} / {list.total} 张 · 已加载 {formatBytes(list.loadedBytes)}</span>
  <span class="hint">按 SHA-256 判定的相同图片不会重复存储</span>
  <label class="sr-only" for="image-search">搜索文件名</label>
  <input
    id="image-search"
    class="input max-w-56"
    placeholder="搜索文件名"
    bind:value={query}
    oninput={() => onSearch(query)}
  />
  {#if sel.count}
    <button class="btn btn-danger" disabled={actions.busy} onclick={actions.removeSelected}>
      {actions.busy ? "删除中…" : `删除选中 (${sel.count})`}
    </button>
  {/if}
  <button class="btn btn-primary ml-auto" onclick={() => navigate("/upload?mode=image")}>上传图片</button>
</div>

{#if list.loading}
  <p class="text-sm text-slate-500">加载中…</p>
{:else if list.error}
  <div class="card text-sm text-rose-600">
    {list.error}
    <button class="btn btn-ghost btn-sm ml-2" onclick={() => void list.load(true)}>重试</button>
  </div>
{:else if !list.items.length}
  <div class="card text-sm text-slate-500">{list.total ? "没有匹配的图片。" : "还没有图片，去上传一张吧。"}</div>
{:else}
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
    {#each list.items as entry (entry.id)}
      <div class="group relative overflow-hidden rounded-lg border border-slate-200 bg-slate-50 hover:border-sky-300">
        <button class="block w-full" onclick={() => (lightbox = entry)} aria-label={`查看 ${entry.filename}`}>
          <Thumb id={entry.id} filename={entry.filename} />
          <span
            class="absolute inset-x-0 bottom-0 truncate bg-slate-900/60 px-2 py-1 text-left text-xs text-white opacity-0 transition-opacity group-hover:opacity-100"
          >
            {entry.filename} · {formatBytes(entry.size)}
          </span>
        </button>
        <label class="absolute left-2 top-2 flex h-6 w-6 items-center justify-center rounded bg-white/85">
          <input
            type="checkbox"
            class="h-4 w-4 accent-sky-600"
            checked={sel.selected.has(entry.id)}
            onchange={() => sel.toggle(entry.id)}
            aria-label={`选择 ${entry.filename}`}
          />
        </label>
      </div>
    {/each}
  </div>

  {#if list.hasMore}
    <div class="mt-4 text-center">
      <button class="btn btn-ghost" disabled={list.loadingMore} onclick={() => void list.load(false)}>
        {list.loadingMore ? "加载中…" : `加载更多（剩余 ${list.total - list.items.length} 张）`}
      </button>
    </div>
  {/if}
{/if}

{#if lightbox}
  <ImageViewer entry={lightbox} onClose={() => (lightbox = null)} onDelete={actions.remove} />
{/if}
