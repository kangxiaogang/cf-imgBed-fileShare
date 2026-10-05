<script lang="ts">
  import { bbcodeImage, bbcodeLink, htmlImage, markdownImage, markdownLink } from "@picoshare/shared";
  import { copyWithFlash } from "../lib/clipboard";

  let {
    url,
    filename,
    image = false,
    rich = true,
    inverse = false,
  }: {
    url: string;
    filename: string;
    image?: boolean;
    rich?: boolean;
    inverse?: boolean;
  } = $props();

  const buttonClass = $derived(
    inverse ? "btn btn-ghost btn-sm bg-white/10 text-white" : "btn btn-ghost btn-sm",
  );
  const markdown = $derived(image ? markdownImage(url, filename) : markdownLink(url, filename));
  const html = $derived(htmlImage(url, filename));
  const bbcode = $derived(image ? bbcodeImage(url) : bbcodeLink(url));
</script>

<div class="flex flex-wrap gap-2">
  <button
    class={buttonClass}
    onclick={() => void copyWithFlash(url, image ? "图片直链已复制" : "链接已复制")}>复制直链</button
  >
  {#if rich}
    <button class={buttonClass} onclick={() => void copyWithFlash(markdown, "Markdown 已复制")}
      >复制 Markdown</button
    >
    <button class={buttonClass} onclick={() => void copyWithFlash(html, "HTML 已复制")}>复制 HTML</button>
    <button class={buttonClass} onclick={() => void copyWithFlash(bbcode, "BBCode 已复制")}>复制 BBCode</button>
  {/if}
</div>
