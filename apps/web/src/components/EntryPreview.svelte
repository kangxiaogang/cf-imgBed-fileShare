<script lang="ts">
  import type { Entry } from "@picoshare/shared";
  import { imageLink } from "../lib/format";
  import { previewUrl } from "../lib/preview.svelte";
  import CopyLinkButtons from "./CopyLinkButtons.svelte";

  let { entry }: { entry: Entry } = $props();

  // Keyed on the id only: the effect re-runs for the whole `entry` object otherwise, so every
  // metadata save and every content replace re-downloaded the full image.
  const preview = previewUrl(() => `/api/entry/${encodeURIComponent(entry.id)}/preview`);

  const directLink = $derived(entry.share_id ? imageLink(entry.share_id, entry.filename) : null);
</script>

<div class="card mb-4">
  <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
    <h2 class="card-title mb-0">预览</h2>
    {#if directLink}
      <CopyLinkButtons url={directLink} filename={entry.filename} image />
    {:else}
      <!-- Every share revoked: the bytes are still here and still previewable, there is just
           nobody to hand a link to. The share section below mints another. -->
      <span class="text-xs text-slate-500">未分享</span>
    {/if}
  </div>
  {#if preview.url}
    <img src={preview.url} alt={entry.filename} class="mx-auto max-h-96 rounded-lg bg-slate-50 object-contain" />
  {/if}
</div>
