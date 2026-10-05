<script lang="ts">
  import type { FileVersion } from "@picoshare/shared";
  import { download } from "../lib/api";
  import { formatBytes, formatDate } from "../lib/format";

  let {
    entryId,
    versions,
    currentVersion,
    onDelete,
  }: {
    entryId: string;
    versions: FileVersion[];
    currentVersion: number;
    onDelete: (version: number) => void;
  } = $props();

  const versionPath = (version: number) =>
    `/api/entry/${encodeURIComponent(entryId)}/versions/${version}/content`;
</script>

<div class="card mt-4">
  <h2 class="card-title">历史版本</h2>
  <div class="overflow-x-auto">
    <table class="w-full min-w-[620px]">
      <thead class="border-b border-slate-200">
        <tr>
          <th class="table-th">版本</th>
          <th class="table-th">大小</th>
          <th class="table-th">时间</th>
          <th class="table-th">SHA-256</th>
          <th class="table-th text-right">操作</th>
        </tr>
      </thead>
      <tbody>
        {#each versions as version (version.version)}
          <tr class="border-b border-slate-100 last:border-0">
            <td class="table-td">
              {version.version}
              {#if version.version === currentVersion}
                <span class="chip ml-1">当前</span>
              {/if}
            </td>
            <td class="table-td">{formatBytes(version.size)}</td>
            <td class="table-td whitespace-nowrap">{formatDate(version.created_time)}</td>
            <td class="table-td font-mono text-xs text-slate-500">
              {version.sha256 ? `${version.sha256.slice(0, 16)}…` : "-"}
            </td>
            <td class="table-td text-right whitespace-nowrap">
              <button
                class="btn btn-ghost btn-sm"
                onclick={() => void download(versionPath(version.version), version.filename)}
              >
                下载
              </button>
              {#if version.version !== currentVersion}
                <button class="btn btn-danger btn-sm" onclick={() => onDelete(version.version)}>删除</button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
