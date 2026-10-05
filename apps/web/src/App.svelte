<script lang="ts">
  import { navigate, route, safeDecode } from "./lib/router.svelte";
  import { session } from "./lib/session.svelte";
  import { confirmBox, flash } from "./lib/ui.svelte";

  import Login from "./views/Login.svelte";
  import Entries from "./views/Entries.svelte";
  import EntryDetail from "./views/EntryDetail.svelte";
  import Images from "./views/Images.svelte";
  import Upload from "./views/Upload.svelte";
  import GuestLinks from "./views/GuestLinks.svelte";
  import GuestUpload from "./views/GuestUpload.svelte";
  import Settings from "./views/Settings.svelte";

  const current = $derived(route.path);
  const segments = $derived(route.segments);
  const isGuestPage = $derived(segments[0] === "guest" && segments.length >= 2);

  const nav = [
    { href: "/", label: "文件" },
    { href: "/images", label: "图片" },
    { href: "/upload", label: "上传" },
    { href: "/guest-links", label: "访客链接" },
    { href: "/settings", label: "设置" },
  ];

  function logout() {
    session.clear();
    navigate("/");
  }

  const isActive = (href: string) =>
    href === "/" ? current === "/" : current === href || current.startsWith(`${href}/`);

  let confirmDialog: HTMLDivElement | undefined = $state();

  // Move focus into the dialog when it opens so keyboard and screen-reader users are not
  // left on the control that opened it, behind the overlay.
  $effect(() => {
    if (confirmBox.value) confirmDialog?.focus();
  });
</script>

{#if isGuestPage}
  {#key segments[1]}
    <GuestUpload id={safeDecode(segments[1] ?? "")} />
  {/key}
{:else}
  <div class="min-h-screen">
    <header class="sticky top-0 z-10 border-b border-slate-200 bg-white">
      <div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
        <button class="flex items-center gap-2 font-semibold text-slate-800" onclick={() => navigate("/")}>
          <span class="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-600 text-xs font-bold text-white"
            >P</span
          >
          PicoShare
        </button>
        {#if session.authed}
          <nav class="flex gap-1 overflow-x-auto">
            {#each nav as item (item.href)}
              <button
                class="rounded-lg px-3 py-1.5 text-sm font-medium {isActive(item.href)
                  ? 'bg-sky-50 text-sky-700'
                  : 'text-slate-600 hover:bg-slate-100'}"
                onclick={() => navigate(item.href)}
              >
                {item.label}
              </button>
            {/each}
          </nav>
          <button class="btn btn-ghost btn-sm ml-auto" onclick={logout}>退出登录</button>
        {/if}
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-4 py-6">
      {#if flash.value}
        <div class="mb-4 flex items-start justify-between rounded-lg border px-4 py-3 text-sm {flash.value.kind === 'ok' ? 'flash-ok' : 'flash-error'}">
          <span>{flash.value.message}</span>
          <button class="ml-4 opacity-60 hover:opacity-100" onclick={() => flash.hide()}>✕</button>
        </div>
      {/if}

      {#if !session.authed}
        <Login />
      {:else if current === "/upload"}
        <Upload />
      {:else if current === "/images"}
        <Images />
      {:else if current === "/guest-links"}
        <GuestLinks />
      {:else if current === "/settings"}
        <Settings />
      {:else if segments[0] === "entry" && segments[1]}
        <!-- onMount runs once per instance, so the component must be rebuilt when the id
             changes; otherwise browser back/forward shows the previous entry's data. -->
        {#key segments[1]}
          <EntryDetail id={safeDecode(segments[1])} />
        {/key}
      {:else}
        <Entries />
      {/if}
    </main>
  </div>

  {#if confirmBox.value}
    <!-- z-40 must stay above the image lightbox (z-30), otherwise a confirm opened from
         inside the lightbox is painted underneath it: invisible, unclickable, and its
         promise never resolves, which hangs the caller's delete flow. -->
    <div
      bind:this={confirmDialog}
      class="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-message"
      tabindex="-1"
      onkeydown={(e) => e.key === "Escape" && confirmBox.answer(false)}
    >
      <div class="card w-full max-w-sm">
        <p id="confirm-message" class="text-sm text-slate-700">{confirmBox.value.message}</p>
        <div class="mt-5 flex justify-end gap-2">
          <button class="btn btn-ghost" onclick={() => confirmBox.answer(false)}>取消</button>
          <button class="btn btn-danger" onclick={() => confirmBox.answer(true)}>确认</button>
        </div>
      </div>
    </div>
  {/if}
{/if}
