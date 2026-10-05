<script lang="ts">
  import { DEFAULT_EXPIRATION_DAYS } from "@picoshare/shared";

  /**
   * One control for "keep this forever, or keep it for N days", shared by the upload form, the
   * entry editor and the guest-link form.
   *
   * The value is `number | null` in all three, and `null` means the same thing on all three:
   * nothing expires. That was previously three state shapes — a `""`-or-digits string on upload,
   * a `hasExpiration` boolean beside a number on the entry editor, and a nullable number on
   * guest links — with a separate conversion in each direction on every page. What is left is
   * smaller than the sum of its parts because the awkward parts were the duplicated conversions,
   * not the markup: one label, one bound, and one place to change either of them.
   *
   * The days are not clamped here. The server clamps on both the create and the update path, so
   * clamping in the browser would only hide what the user typed without changing what is stored.
   * The bound is on the input, as a hint rather than as enforcement.
   *
   * A list of common durations was offered here — first as a `<select>`, then as a `<datalist>`
   * attached to the field. Both were dropped: a select cannot hold a value it does not offer, so it
   * needed the current value spliced back into its own options, and a datalist puts a second,
   * competing list of numbers directly under the one the user is typing into. Neither earned its
   * place, and the field alone is the whole answer to "how long".
   */
  let {
    id,
    value = $bindable(null),
    label = "过期天数（从今天起）",
    emptyText = "不限",
    checkable = false,
    fallbackDays = DEFAULT_EXPIRATION_DAYS,
    onchange,
  }: {
    id: string;
    value?: number | null;
    label?: string;
    /** What an empty field means here. Read as a placeholder, so it has to be short. */
    emptyText?: string;
    /** Render the tick box that stands for "expire at all". Off for a nullable limit field. */
    checkable?: boolean;
    /**
     * What a tick restores when this field has no number of its own to go back to.
     *
     * A constant cannot do this job. The upload form renders this control before its settings have
     * arrived, so a fallback read at construction time is read from `null` and then frozen in for
     * as long as the page stays open — which is how the upload form could offer 30 days while the
     * settings page said 14. Read live instead, and let the caller pass in what it is configured
     * for, so the two cannot disagree.
     */
    fallbackDays?: number;
    /**
     * Called when a change is one the user made. The upload form uses it to stop the configured
     * default, arriving a moment later, from undoing the answer it was just given.
     */
    onchange?: () => void;
  } = $props();

  /**
   * The last number this field really held, which is what a tick restores. `null` until one
   * exists, which is also how "nothing has been set yet" is told apart from "set to something" —
   * the entry editor used to get this for free by keeping `days` beside its `hasExpiration` flag,
   * and folding the two into a single value needs somewhere to keep the number that un-ticking
   * hides.
   */
  let remembered = $state<number | null>(value);

  // A caller can set `value` after this control is already on screen — that is the whole shape of
  // the upload form's default — and un-ticking after that has to leave something behind to restore.
  // Assigned from `value` alone, never the other way round, so it cannot feed back on itself.
  $effect(() => {
    if (value !== null) remembered = value;
  });

  const restore = $derived(value ?? remembered ?? fallbackDays);

  function set(next: number | null) {
    value = next;
    if (next !== null) remembered = next;
    onchange?.();
  }

  function toggle(on: boolean) {
    set(on ? restore : null);
  }

  function onDays(event: Event & { currentTarget: HTMLInputElement }) {
    const raw = event.currentTarget.valueAsNumber;
    if (!Number.isFinite(raw) || raw <= 0) {
      // Only the tick-box variant has a second way to say "no expiry". In a plain nullable limit
      // field the empty box *is* how a limit is removed, and refusing to clear it would leave the
      // limit live behind a field that looks blank. With the tick box, clearing the number keeps
      // the setting as it was — otherwise deleting the digits would switch expiry off, and the
      // control would collapse out from under the cursor while the user was still typing.
      if (!checkable) set(null);
      return;
    }
    set(Math.round(raw));
  }
</script>

{#if checkable}
  <label class="mt-3 flex items-center gap-2 text-sm text-slate-700">
    <input
      type="checkbox"
      class="h-4 w-4 accent-sky-600"
      checked={value !== null}
      onchange={(event) => toggle(event.currentTarget.checked)}
    />
    设置过期时间
  </label>
{/if}

{#if !checkable || value !== null}
  <label class="label {checkable ? 'mt-2' : 'mt-3'}" for={id}>{label}</label>
  <input
    {id}
    class="input max-w-40"
    type="number"
    min="1"
    max="3650"
    placeholder={checkable ? undefined : emptyText}
    value={value ?? ""}
    oninput={onDays}
  />
{/if}