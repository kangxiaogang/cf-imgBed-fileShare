<script lang="ts">
  import { MAX_PASTE_LENGTH } from "@picoshare/shared";
  import { formatBytes } from "../lib/format";
  import { flash } from "../lib/ui.svelte";

  let {
    files = $bindable<File[]>([]),
    text = $bindable(""),
    hint = "支持拖拽、点击选择或多选文件",
    imageOnly = false,
    maxFiles,
  }: { files: File[]; text: string; hint?: string; imageOnly?: boolean; maxFiles?: number } = $props();

  let dragging = $state(false);
  let input: HTMLInputElement | undefined = $state();

  const accept = (file: File): boolean => {
    if (!imageOnly) return true;
    if (file.type.startsWith("image/")) return true;
    flash.show(`「${file.name}」不是图片，已忽略`, "error");
    return false;
  };

  function add(list: FileList | null | undefined) {
    if (!list?.length) return;
    const picked = Array.from(list).filter(accept);
    // The server rejects the whole request when the count is over its cap; catching it here
    // means the user is told before uploading instead of after. The cap counts what is
    // already staged, so repeated drops cannot walk past it either.
    const room = maxFiles === undefined ? picked.length : Math.max(0, maxFiles - files.length);
    if (picked.length > room) {
      flash.show(`一次最多选择 ${maxFiles} 个文件，已忽略多余的 ${picked.length - room} 个`, "error");
    }
    if (room > 0) files = [...files, ...picked.slice(0, room)];
  }

  function remove(index: number) {
    files = files.filter((_, i) => i !== index);
  }
</script>

<div
  class="cursor-pointer rounded-xl border-2 border-dashed px-4 py-8 text-center {dragging
    ? 'border-sky-400 bg-sky-50'
    : 'border-slate-300 bg-white hover:border-sky-300'}"
  role="button"
  tabindex="0"
  onclick={() => input?.click()}
  onkeydown={(e) => e.key === "Enter" && input?.click()}
  ondragover={(e) => {
    e.preventDefault();
    dragging = true;
  }}
  ondragleave={() => (dragging = false)}
  ondrop={(e) => {
    e.preventDefault();
    dragging = false;
    add(e.dataTransfer?.files);
  }}
>
  <p class="text-sm font-medium text-slate-700">
    {imageOnly ? "拖拽图片到此处，或点击选择" : "拖拽文件到此处，或点击选择"}
  </p>
  <p class="hint">{hint}</p>
</div>
<input
  class="hidden"
  type="file"
  accept={imageOnly ? "image/*" : undefined}
  multiple
  bind:this={input}
  onchange={(e) => {
    add(e.currentTarget.files);
    e.currentTarget.value = "";
  }}
/>

{#if files.length}
  <ul class="mt-3 space-y-1.5">
    {#each files as file, i (file.name + file.size + i)}
      <li class="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <span class="truncate text-sm text-slate-700">{file.name}</span>
        <span class="flex shrink-0 items-center gap-3 text-xs text-slate-500">
          {formatBytes(file.size)}
          <button class="text-rose-500 hover:text-rose-700" onclick={() => remove(i)}>移除</button>
        </span>
      </li>
    {/each}
  </ul>
{/if}

{#if !imageOnly}
  <div class="mt-4">
    <label class="label" for="paste-text">或粘贴文本</label>
    <textarea
      id="paste-text"
      class="input min-h-24 resize-y"
      bind:value={text}
      maxlength={MAX_PASTE_LENGTH}
      placeholder="粘贴文本内容，会保存为独立文件"
    ></textarea>
  </div>
{/if}
