<script lang="ts">
  import { onMount } from "svelte";
  import { previewUrl } from "../lib/preview.svelte";

  let { id, filename }: { id: string; filename: string } = $props();

  const placeholder =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='4' height='4'%3E%3C/svg%3E";

  // The gallery has no thumbnail endpoint, so each tile holds a full-resolution blob until it
  // unmounts. Deferring the fetch until the tile scrolls into view keeps off-screen tiles free.
  let visible = $state(false);
  const preview = previewUrl(
    () => `/api/entry/${encodeURIComponent(id)}/preview`,
    () => visible,
  );
  let src = $derived(preview.url || placeholder);

  let el: HTMLImageElement | undefined = $state();

  onMount(() => {
    const target = el;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      visible = true;
    });
    observer.observe(target);
    return () => observer.disconnect();
  });
</script>

{#if preview.failed}
  <div class="flex aspect-square w-full items-center justify-center bg-slate-100 text-xs text-slate-400">
    无法预览
  </div>
{:else}
  <img bind:this={el} {src} alt={filename} loading="lazy" class="aspect-square w-full object-cover" />
{/if}
