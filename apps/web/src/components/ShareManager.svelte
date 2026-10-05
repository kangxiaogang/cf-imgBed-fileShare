<script lang="ts">
  import type { Share } from "@picoshare/shared";
  import { errorMessage } from "../lib/errors";
  import { api } from "../lib/api";
  import { copyWithFlash } from "../lib/clipboard";
  import { formatDate, shortLink } from "../lib/format";
  import { confirmAction, flash } from "../lib/ui.svelte";

  let {
    entryId,
    filename = "",
    onClose,
  }: { entryId: string; filename?: string; onClose: () => void } = $props();

  /**
   * The management of one entry's links, as a dialog rather than a page.
   *
   * A page would need a route, and the thing it manages belongs to the row you opened it from —
   * the list is where sharing happens and a modal puts it right there. More to the point, the
   * button that opens this used to be 复制链接, which cannot answer a fair question once an entry
   * has more than one link: *which* link? Naming the action 管理 and showing every link with its
   * own copy button costs one extra click and removes the ambiguity entirely.
   *
   * Opened from both the file list and an entry's detail page, so the two cannot drift into
   * different sets of capabilities.
   */
  let shares = $state<Share[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  let busy = $state(false);
  let label = $state("");
  let days = $state<number | null>(null);

  /** Which row has its note open for editing, and what has been typed into it. */
  let editing = $state<string | null>(null);
  let editLabel = $state("");

  let dialog: HTMLDivElement | undefined = $state();

  // Move focus into the dialog so the keyboard and a screen reader land inside it rather than
  // back on the list behind, where the next Tab would walk rows nobody can see.
  $effect(() => {
    dialog?.focus();
  });

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") onClose();
  }

  async function load() {
    loading = true;
    try {
      shares = await api.api.entry[":id"].shares.$get({ param: { id: entryId } });
    } catch (err) {
      loadError = errorMessage(err);
    } finally {
      loading = false;
    }
  }

  load();

  const shareState = (share: Share): "永不过期" | "已失效" | string => {
    if (!share.expires_at) return "永不过期";
    return Date.parse(share.expires_at) <= Date.now() ? "已失效" : formatDate(share.expires_at);
  };

  const liveCount = $derived(shares.filter((share) => shareState(share) !== "已失效").length);

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const made = await api.api.entry[":id"].shares.$post({
        param: { id: entryId },
        json: { label: label.trim() || null, expiresInDays: days },
      });
      shares = [made, ...shares];
      label = "";
      days = null;
      flash.show("分享链接已创建");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      busy = false;
    }
  }

  async function revoke(share: Share) {
    if (
      !(await confirmAction("确定撤销这个分享链接吗？文件本身不会被删除，随时可以再创建一个。"))
    ) {
      return;
    }
    try {
      await api.api.shares[":id"].$delete({ param: { id: share.id } });
      shares = shares.filter((item) => item.id !== share.id);
      flash.show("分享链接已撤销");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  async function makePermanent(share: Share) {
    try {
      const updated = await api.api.shares[":id"].$put({
        param: { id: share.id },
        json: { expiresInDays: null },
      });
      shares = shares.map((item) => (item.id === updated.id ? updated : item));
      flash.show("已改为永不过期");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  function startEdit(share: Share) {
    editing = share.id;
    editLabel = share.label ?? "";
  }

  /**
   * Sends the label and nothing else. A partial update is the point: sending the deadline as
   * well would silently reset one the owner opened the note to change nothing about.
   */
  async function saveNote(share: Share) {
    const next = editLabel.trim();
    editing = null;
    if (next === (share.label ?? "")) return;
    try {
      const updated = await api.api.shares[":id"].$put({
        param: { id: share.id },
        json: { label: next || null },
      });
      shares = shares.map((item) => (item.id === updated.id ? updated : item));
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }
</script>

<!--
  On the window, not the dialog: keydown is delivered to `document.activeElement` and bubbles
  through its ancestors, and with the listener on the dialog Escape would only work while
  something inside happened to hold focus. Same reasoning as the image lightbox.
-->
<svelte:window onkeydown={onKeydown} />

<!-- z-30, and it has to stay *below* the confirm dialog's z-40. This dialog opens that confirm —
     to revoke a link — and App renders the confirm as a sibling of the page, so with a higher z
     here it would be painted over: the question never appears, nothing can be clicked, and the
     promise behind `confirmAction` never settles, which hangs the revoke. Same reason the image
     lightbox sits at z-30. -->
<div
  class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4"
  role="dialog"
  aria-modal="true"
  aria-labelledby="share-manager-title"
  tabindex="-1"
  bind:this={dialog}
  onclick={(e) => e.target === e.currentTarget && onClose()}
  onkeydown={onKeydown}
>
  <div class="card my-8 w-full max-w-2xl">
    <div class="flex flex-wrap items-center gap-2">
      <h2 id="share-manager-title" class="card-title mb-0">分享链接</h2>
      {#if filename}<span class="truncate text-sm text-slate-500">{filename}</span>{/if}
      <button
        class="btn btn-ghost btn-sm ml-auto"
        onclick={onClose}
        aria-label="关闭">✕</button
      >
    </div>

    <p class="hint mt-2">
      一个文件可以创建多条分享链接，每条可以单独设置有效期。撤销或过期都<b>不会删除文件</b>。
    </p>

    {#if loading}
      <p class="mt-4 text-sm text-slate-500">加载中…</p>
    {:else if loadError}
      <div class="card mt-4 border-rose-200 bg-rose-50 text-sm text-rose-700">{loadError}</div>
    {:else}
      {#if shares.length}
        <ul class="mt-4 space-y-2">
          {#each shares as share (share.id)}
            {@const where = shareState(share)}
            <li class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <div class="flex flex-wrap items-center gap-2">
                {#if editing === share.id}
                  <!-- Inline rather than a prompt(): the note is the only free text in here and a
                       modal for one word is heavier than the edit. -->
                  <input
                    class="input max-w-56"
                    maxlength="120"
                    bind:value={editLabel}
                    aria-label="链接备注"
                    placeholder="给这个链接起个名字"
                  />
                  <button class="btn btn-primary btn-sm" onclick={() => void saveNote(share)}>保存</button>
                  <button class="btn btn-ghost btn-sm" onclick={() => (editing = null)}>取消</button>
                {:else}
                  <span class="font-medium text-slate-800">{share.label || "（无备注）"}</span>
                  <span class="text-xs text-slate-500">{where}</span>
                  <span class="ml-auto flex flex-wrap items-center gap-2">
                    <button class="btn btn-ghost btn-sm" onclick={() => startEdit(share)}>备注</button>
                    {#if share.expires_at && where !== "已失效"}
                      <button class="btn btn-ghost btn-sm" onclick={() => void makePermanent(share)}
                        >改为永不过期</button
                      >
                    {/if}
                    <!-- Per row, so there is never a question about which link this copies. -->
                    <button
                      class="btn btn-ghost btn-sm"
                      onclick={() => void copyWithFlash(shortLink(share.id), "链接已复制")}>复制</button
                    >
                    <button class="btn btn-danger btn-sm" onclick={() => void revoke(share)}>撤销</button>
                  </span>
                {/if}
              </div>
              <p class="hint">创建于 {formatDate(share.created_time)}</p>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="mt-4 text-sm text-slate-500">
          还没有分享链接。别人无法通过链接下载这个文件，但文件本身完好无损。
        </p>
      {/if}

      <form class="mt-4 border-t border-slate-200 pt-4" onsubmit={create}>
        <label class="label" for="new-share-label">分享备注</label>
        <input
          id="new-share-label"
          class="input"
          maxlength="120"
          bind:value={label}
          placeholder="例如：发给设计同事"
        />
        <p class="hint">只有你自己能看到这个备注。</p>
        <label class="label mt-3" for="new-share-days">链接有效天数</label>
        <input
          id="new-share-days"
          class="input max-w-40"
          type="number"
          min="1"
          max="3650"
          bind:value={days}
          placeholder="留空表示永不过期"
        />
        <p class="hint">只限制这条链接，不影响文件本身可以保留多久。</p>
        <div class="mt-4 flex flex-wrap items-center gap-2">
          <button class="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "创建中…" : "创建分享链接"}
          </button>
          <span class="text-xs text-slate-500">当前 {liveCount} 条可用</span>
        </div>
      </form>
    {/if}
  </div>
</div>