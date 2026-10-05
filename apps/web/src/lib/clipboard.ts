import { flash } from "./ui.svelte";

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyWithFlash(
  text: string,
  message: string,
  failMessage = "复制失败，请手动复制",
): Promise<boolean> {
  const ok = await copyText(text);
  flash.show(ok ? message : failMessage, ok ? "ok" : "error");
  return ok;
}
