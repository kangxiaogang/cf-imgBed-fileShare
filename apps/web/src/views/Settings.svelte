<script lang="ts">
  import { DEFAULT_EXPIRATION_DAYS } from "@picoshare/shared";
  import { errorMessage } from "../lib/errors";
  import type { SystemInfo } from "@picoshare/shared";
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { formatBytes, formatDate } from "../lib/format";
  import { flash } from "../lib/ui.svelte";

  // Placeholders, not values. What is read replaces them; `settingsLoaded` says which, and the
  // save button is shut until it does — these two are the ones that decide whether anything ever
  // expires, and submitting them over a configured setting would quietly rewrite it.
  let storeForever = $state(true);
  let defaultDays = $state(DEFAULT_EXPIRATION_DAYS);
  let settingsLoaded = $state(false);
  let info = $state<SystemInfo | null>(null);
  let infoLoaded = $state(false);
  /** When the counters below were read, which is not when the settings were. */
  let fetchedAt = $state("");
  let saving = $state(false);

  onMount(async () => {
    try {
      const settings = await api.api.settings.$get();
      storeForever = settings.storeForever;
      defaultDays = settings.defaultDays;
      // Set here rather than in a `finally`: this means "read", not "tried". Failing to read is
      // exactly the state the disabled button exists for, and a `finally` would unlock it.
      settingsLoaded = true;
    } catch (err) {
      flash.show(errorMessage(err), "error");
    }

    // Read separately, and after the settings rather than alongside them.
    //
    // These counters were in a `Promise.all` with the settings, so a failure here threw away a
    // settings response that had already arrived — leaving the form on its placeholder values with
    // the save button live, one click away from writing "keep everything forever" over whatever
    // had been configured. An optional panel must not be able to disarm the one beside it.
    try {
      info = await api.api["system-info"].$get();
      fetchedAt = new Date().toISOString();
    } catch {
      // the counters are optional; the settings above are not
    } finally {
      infoLoaded = true;
    }
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    try {
      await api.api.settings.$put({ json: { storeForever, defaultDays: Number(defaultDays) } });
      flash.show("设置已保存");
      fetchedAt = new Date().toISOString();
    } catch (err) {
      flash.show(errorMessage(err), "error");
    } finally {
      saving = false;
    }
  }

  const stats = $derived(
    info
      ? [
          { label: "存储占用", value: formatBytes(info.upload_data_bytes) },
          { label: "文件数量", value: String(info.entry_count) },
          { label: "访客链接", value: String(info.guest_link_count) },
          { label: "下载次数", value: String(info.download_count) },
        ]
      : [],
  );
</script>

<h1 class="mb-4 text-lg font-semibold text-slate-800">设置</h1>

<div class="grid gap-4 lg:grid-cols-2">
  <form class="card" onsubmit={save}>
    <h2 class="card-title">上传默认值</h2>
    <label class="flex items-center gap-2 text-sm text-slate-700">
      <input type="checkbox" class="h-4 w-4 accent-sky-600" bind:checked={storeForever} />
      新文件永久保存（不设置过期时间）
    </label>
    {#if !storeForever}
      <!-- Hidden, not disabled, when everything is kept forever: the value does not take part
           in any decision then, and a greyed-out field beside "永久保存" reads as if both
           settings were in force. -->
      <label class="label mt-4" for="default-days">默认过期天数</label>
      <input
        id="default-days"
        class="input max-w-40"
        type="number"
        min="1"
        max="3650"
        bind:value={defaultDays}
      />
      <p class="hint">未勾选永久保存时，上传页会默认使用该天数。</p>
    {/if}
    <!-- Shut until the settings have actually been read. `storeForever` and `defaultDays` hold
         stand-in values until then, and these two decide whether anything ever expires — so
         submitting them before the read is not a no-op, it is a rewrite. -->
    <button class="btn btn-primary mt-4" type="submit" disabled={saving || !settingsLoaded}>
      {saving ? "保存中…" : "保存设置"}
    </button>
  </form>

  <div class="card">
    <h2 class="card-title">系统信息</h2>
    {#if info}
      <dl class="grid grid-cols-2 gap-3">
        {#each stats as stat (stat.label)}
          <div class="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <dt class="text-xs text-slate-500">{stat.label}</dt>
            <dd class="text-base font-semibold text-slate-800">{stat.value}</dd>
          </div>
        {/each}
      </dl>
      <p class="hint mt-3">获取于 {formatDate(fetchedAt)}（含历史版本占用）</p>
    {:else if !infoLoaded}
      <p class="text-sm text-slate-500">加载中…</p>
    {:else}
      <!-- Said plainly, because "加载中…" left up forever is what this replaces: the counters are
           read after the settings, on purpose, so a failure here is its own and not theirs. -->
      <p class="text-sm text-slate-500">读取失败，计数器不可用。设置不受影响。</p>
    {/if}
  </div>
</div>
