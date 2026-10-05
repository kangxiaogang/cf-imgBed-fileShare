<script lang="ts">
  import { errorMessage } from "../lib/errors";
  import type { GuestLink } from "@picoshare/shared";
  import { formatMiB, MAX_GUEST_FILE_BYTES } from "@picoshare/shared";
  import { onMount } from "svelte";
  import ExpiryDays from "../components/ExpiryDays.svelte";
  import { api } from "../lib/api";
  import { copyWithFlash } from "../lib/clipboard";
  import { formatDate, guestUrl } from "../lib/format";
  import { confirmAction, flash } from "../lib/ui.svelte";

  let links = $state<GuestLink[]>([]);
  let loading = $state(true);
  let saving = $state(false);

  let label = $state("");
  // Svelte assigns `number | null` to a number input, and `null` for an empty field, so
  // these cannot be typed as string.
  let maxMb = $state<number | null>(null);
  let maxDays = $state<number | null>(null);
  let maxUploads = $state<number | null>(null);
  let urlExpires = $state("");

  onMount(() => {
    void load();
  });

  async function load() {
    try {
      links = await api.api["guest-links"].$get();
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      loading = false;
    }
  }

  const isExpired = (link: GuestLink) => !!link.url_expires && Date.parse(link.url_expires) <= Date.now();

  async function create(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      await api.api["guest-links"].$post({
        json: {
          label: label.trim() || null,
          // Absent, not null, when left blank: the server's `positiveInt(...) ?? default` only
          // applies its default when the field is missing, and an explicit `null` would be
          // silently replaced by the same default anyway — sending it just hides which one.
          ...(maxMb === null ? {} : { max_file_bytes: Math.round(maxMb * 1024 * 1024) }),
          max_file_lifetime_days: maxDays,
          max_file_uploads: maxUploads,
          url_expires: urlExpires || null,
        },
      });
      label = "";
      maxMb = null;
      maxDays = null;
      maxUploads = null;
      urlExpires = "";
      flash.show("访客链接已创建");
      await load();
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      saving = false;
    }
  }

  async function remove(link: GuestLink) {
    if (
      !(await confirmAction(
        link.entry_count
          ? `确定删除这个访客链接吗？它上传的 ${link.entry_count} 个文件会保留并回到文件列表。`
          : "确定删除这个访客链接吗？",
      ))
    )
      return;
    try {
      await api.api["guest-links"][":id"].$delete({ param: { id: link.id } });
      links = links.filter((item) => item.id !== link.id);
      flash.show("访客链接已删除");
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }
  }

  const limitText = (link: GuestLink): string => {
    const parts: string[] = [];
    // formatMiB keeps a 0.5MB limit from rendering as "1MB"; Math.round would misstate it.
    parts.push(`单文件 ≤ ${formatMiB(link.max_file_bytes)}MB`);
    parts.push(
      link.max_file_uploads ? `上传 ${link.upload_count ?? 0}/${link.max_file_uploads} 次` : "次数不限",
    );
    parts.push(link.max_file_lifetime_days ? `文件 ${link.max_file_lifetime_days} 天过期` : "文件不过期");
    parts.push(`已上传 ${link.entry_count} 个文件`);
    return parts.join(" · ");
  };
</script>

<h1 class="mb-4 text-lg font-semibold text-slate-800">访客链接</h1>

<div class="grid gap-4 lg:grid-cols-[320px_1fr]">
  <form class="card h-fit" onsubmit={create}>
    <h2 class="card-title">创建访客链接</h2>
    <p class="hint mb-3">访客无需登录即可通过该链接上传文件。</p>
    <label class="label" for="label">备注</label>
    <input id="label" class="input" maxlength="120" bind:value={label} placeholder="例如：同事小王" />
    <label class="label mt-3" for="max-mb">单文件大小上限 (MB)</label>
    <!-- Blank means the server default (64MB), not "unlimited": the column is NOT NULL and a
         null cap is read as "no limit" by the enforcement path, so the field cannot promise
         what the server will never store. The default is shown as the placeholder. -->
    <input
      id="max-mb"
      class="input"
      type="number"
      min="1"
      bind:value={maxMb}
      placeholder={`默认 ${formatMiB(MAX_GUEST_FILE_BYTES)}MB`}
    />
    <ExpiryDays id="max-days" bind:value={maxDays} label="文件保存天数" />
    <label class="label mt-3" for="max-uploads">上传次数上限</label>
    <input id="max-uploads" class="input" type="number" min="1" bind:value={maxUploads} placeholder="不限" />
    <label class="label mt-3" for="url-expires">链接失效日期</label>
    <input id="url-expires" class="input" type="date" bind:value={urlExpires} />
    <button class="btn btn-primary mt-4 w-full" type="submit" disabled={saving}>
      {saving ? "创建中…" : "创建链接"}
    </button>
  </form>

  <div class="card p-0">
    {#if loading}
      <p class="p-5 text-sm text-slate-500">加载中…</p>
    {:else if !links.length}
      <p class="p-5 text-sm text-slate-500">还没有访客链接。</p>
    {:else}
      <ul class="divide-y divide-slate-100">
        {#each links as link (link.id)}
          <li class="flex flex-wrap items-center gap-3 px-4 py-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium text-slate-800">
                {link.label || "未命名链接"}
                {#if isExpired(link)}
                  <span class="chip ml-1 border-rose-200 bg-rose-50 text-rose-600">已失效</span>
                {/if}
              </p>
              <p class="truncate text-xs text-slate-500">{limitText(link)}</p>
              <p class="truncate text-xs text-slate-400">
                {guestUrl(link.id)}
                {#if link.url_expires} · 链接失效 {formatDate(link.url_expires)}{/if}
              </p>
            </div>
            <span class="flex items-center gap-2">
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => void copyWithFlash(guestUrl(link.id), "访客链接已复制")}>复制</button
              >
              <button class="btn btn-danger btn-sm" onclick={() => remove(link)}>删除</button>
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>
