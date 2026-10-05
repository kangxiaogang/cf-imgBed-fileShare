<script lang="ts">
  import { errorMessage } from "../lib/errors";
  import { verifySecret } from "../lib/api";
  import { navigate } from "../lib/router.svelte";
  import { session } from "../lib/session.svelte";

  let secret = $state("");
  let error = $state("");
  let busy = $state(false);

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const candidate = secret.trim();
    if (!candidate) {
      error = "请输入访问密钥";
      return;
    }
    busy = true;
    error = "";
    try {
      // Checked against the server before it is stored. Accepting anything and failing later
      // is what made a wrong password and an unconfigured server look like the same problem.
      await verifySecret(candidate);
      session.set(candidate);
      navigate("/");
    } catch (err) {
      // The server's own words: "未授权，请检查访问密钥", or the entrypoint's instructions
      // when it is refusing to serve at all.
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="card mx-auto mt-16 w-full max-w-sm" onsubmit={submit}>
  <h1 class="card-title">登录 PicoShare</h1>
  <label class="label" for="secret">访问密钥</label>
  <input
    id="secret"
    class="input"
    type="password"
    bind:value={secret}
    placeholder="PS_SHARED_SECRET"
    autocomplete="current-password"
  />
  <p class="hint">密钥仅保存在你的浏览器本地。</p>
  {#if error}
    <p class="mt-2 whitespace-pre-line text-sm text-rose-600">{error}</p>
  {/if}
  <button class="btn btn-primary mt-4 w-full" type="submit" disabled={busy}>
    {busy ? "验证中…" : "进入"}
  </button>
</form>
