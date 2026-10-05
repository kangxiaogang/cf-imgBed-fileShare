<script lang="ts">
  import { previewUrl } from "../../src/lib/preview.svelte";

  let { path, enabled = true }: { path: string; enabled?: boolean } = $props();
  const preview = previewUrl(() => path, () => enabled);
</script>

<span data-testid="url">{preview.url}</span>
<span data-testid="loading">{preview.loading}</span>
<span data-testid="failed">{preview.failed}</span>
