<script lang="ts">
  import type { DownloadEvent } from "@picoshare/shared";
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { formatDate } from "../lib/format";

  let {
    entryId,
    refreshKey = 0,
    onCount,
  }: {
    entryId: string;
    /** Bumped by the parent after a download. The record is written; this re-reads it. */
    refreshKey?: number;
    onCount?: (total: number) => void;
  } = $props();

  let events = $state<DownloadEvent[]>([]);
  let total = $state(0);
  let uniqueOnly = $state(true);

  onMount(() => {
    void load();
  });

  // Keyed on the prop rather than on the request, so the parent does not have to own a second
  // copy of this query just to trigger it.
  $effect(() => {
    if (!refreshKey) return;
    void load();
  });

  async function load() {
    try {
      const data = await api.api.entry[":id"].downloads.$get({
        param: { id: entryId },
        query: { uniqueIps: uniqueOnly ? "1" : "0" },
      });
      events = data.events;
      total = data.total;
      // Reported back so the page's own "下载次数" cannot disagree with the panel below it.
      onCount?.(data.total);
    } catch {
      // download history is optional
    }
  }
</script>

<div class="card mt-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h2 class="card-title mb-0">下载记录</h2>
    <label class="flex items-center gap-2 text-sm text-slate-600">
      <input
        type="checkbox"
        class="h-4 w-4 accent-sky-600"
        bind:checked={uniqueOnly}
        onchange={() => void load()}
      />
      按 IP 去重
    </label>
  </div>
  <p class="hint mb-2">共 {total} 条记录</p>
  {#if !events.length}
    <p class="text-sm text-slate-500">暂无下载记录。</p>
  {:else}
    <ul class="divide-y divide-slate-100">
      {#each events as event, i (`${event.downloaded_at}-${event.ip ?? ""}-${i}`)}
        <li class="flex flex-wrap justify-between gap-2 py-2 text-sm">
          <span class="text-slate-700">{formatDate(event.downloaded_at)}</span>
          <span class="text-slate-500">{event.ip || "未知 IP"}</span>
          <span class="max-w-md truncate text-xs text-slate-400">{event.user_agent || "-"}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
