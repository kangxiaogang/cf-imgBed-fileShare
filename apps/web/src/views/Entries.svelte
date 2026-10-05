<script lang="ts">
  import { onMount } from "svelte";
  import type { EntryListItem } from "@picoshare/shared";
  import ShareManager from "../components/ShareManager.svelte";
  import { entryActions } from "../lib/entryActions.svelte";
  import { formatBytes, formatDate } from "../lib/format";
  import { pagedList } from "../lib/pagedList.svelte";
  import { navigate } from "../lib/router.svelte";
  import { selection } from "../lib/selection.svelte";

  const list = pagedList();
  const sel = selection(() => list.items);
  const actions = entryActions({ list, selection: sel, noun: "个文件" });
  let query = $state("");

  /** The entry whose links are open, or null. One at a time: two stacked dialogs help nobody. */
  let managing: EntryListItem | null = $state(null);

  onMount(() => {
    void list.load(true);
    return () => list.dispose();
  });

  function onSearch(value: string) {
    // Ids from the previous result set are still selected but no longer on screen, so a bulk
    // delete would remove files the user cannot see.
    sel.clear();
    list.onSearch(value);
  }


</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
  <h1 class="text-lg font-semibold text-slate-800">文件</h1>
  <span class="chip">{list.items.length} / {list.total} 个 · 已加载 {formatBytes(list.loadedBytes)}</span>
  <label class="sr-only" for="entry-search">搜索文件名</label>
  <input
    id="entry-search"
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
  <button class="btn btn-primary ml-auto" onclick={() => navigate("/upload")}>上传文件</button>
</div>

<div class="card overflow-x-auto p-0">
  <table class="w-full min-w-[760px]">
    <thead class="border-b border-slate-200 bg-slate-50">
      <tr>
        <th scope="col" class="table-th w-10">
          <input
            type="checkbox"
            class="h-4 w-4 accent-sky-600"
            checked={sel.allSelected}
            onchange={sel.toggleAll}
            aria-label="全选"
          />
        </th>
        <th scope="col" class="table-th">文件名</th>
        <th scope="col" class="table-th">大小</th>
        <th scope="col" class="table-th">版本</th>
        <th scope="col" class="table-th">上传时间</th>
        <th scope="col" class="table-th">过期时间</th>
        <th scope="col" class="table-th">下载</th>
        <th scope="col" class="table-th text-right">操作</th>
      </tr>
    </thead>
    <tbody>
      {#if list.loading}
        <tr><td class="table-td text-slate-500" colspan="8">加载中…</td></tr>
      {:else if list.error}
        <tr>
          <td class="table-td text-rose-600" colspan="8">
            {list.error}
            <button class="btn btn-ghost btn-sm ml-2" onclick={() => void list.load(true)}>重试</button>
          </td>
        </tr>
      {:else if !list.items.length}
        <tr>
          <td class="table-td text-slate-500" colspan="8">
            {list.total ? "没有匹配的文件" : "还没有文件，先上传一个吧"}
          </td>
        </tr>
      {:else}
        {#each list.items as entry (entry.id)}
          <tr class="border-b border-slate-100 last:border-0 hover:bg-slate-50">
            <td class="table-td">
              <input
                type="checkbox"
                class="h-4 w-4 accent-sky-600"
                checked={sel.selected.has(entry.id)}
                onchange={() => sel.toggle(entry.id)}
                aria-label={`选择 ${entry.filename}`}
              />
            </td>
            <td class="table-td">
              <button
                class="font-medium text-slate-800 hover:text-sky-700"
                onclick={() => navigate(`/entry/${encodeURIComponent(entry.id)}`)}
              >
                {entry.filename}
              </button>
              {#if entry.note}
                <span class="hint block truncate">{entry.note}</span>
              {/if}
            </td>
            <td class="table-td whitespace-nowrap">{formatBytes(entry.size)}</td>
            <td class="table-td">{entry.version}</td>
            <td class="table-td whitespace-nowrap">{formatDate(entry.upload_time)}</td>
            <td class="table-td whitespace-nowrap">
              {#if entry.expiration_time && Date.parse(entry.expiration_time) <= Date.now()}
                <span class="text-rose-600">已过期</span>
              {:else}
                {entry.expiration_time ? formatDate(entry.expiration_time) : "永久"}
              {/if}
            </td>
            <td class="table-td">{entry.download_count}</td>
            <td class="table-td text-right whitespace-nowrap">
              <button class="btn btn-ghost btn-sm" onclick={() => (managing = entry)}
                >分享管理</button
              >
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => navigate(`/entry/${encodeURIComponent(entry.id)}`)}>详情</button
              >
              <button class="btn btn-danger btn-sm" onclick={() => actions.remove(entry)}>删除</button>
            </td>
          </tr>
        {/each}
        {#if list.hasMore}
          <tr>
            <td class="table-td text-center" colspan="8">
              <button class="btn btn-ghost" disabled={list.loadingMore} onclick={() => void list.load(false)}>
                {list.loadingMore ? "加载中…" : `加载更多（剩余 ${list.total - list.items.length} 个）`}
              </button>
            </td>
          </tr>
        {/if}
      {/if}
    </tbody>
  </table>
</div>

{#if managing}
  <!-- One dialog for both entry points. The list is where sharing happens, and a modal
       puts the links right next to the row that asked for them. Nothing here is refreshed on
       close: the row does not render share state, and reloading would drop a reader who had
       paged down back to the first page. -->
  <ShareManager entryId={managing.id} filename={managing.filename} onClose={() => (managing = null)} />
{/if}
