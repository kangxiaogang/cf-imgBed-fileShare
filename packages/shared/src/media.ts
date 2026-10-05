const EXTRA_INLINE_TYPES = new Set(["application/pdf", "text/plain"]);
const INLINE_PREFIXES = ["image/", "video/", "audio/"];

export const normalizeContentType = (contentType: string | null | undefined): string =>
  (contentType || "").toLowerCase().split(";")[0].trim();

export const isImageContentType = (contentType: string | null | undefined): boolean =>
  normalizeContentType(contentType).startsWith("image/");

export function isInlineSafe(contentType: string | null | undefined): boolean {
  const ct = normalizeContentType(contentType);
  if (!ct || ct === "image/svg+xml") return false;
  if (EXTRA_INLINE_TYPES.has(ct)) return true;
  return INLINE_PREFIXES.some((prefix) => ct.startsWith(prefix));
}

/**
 * Human-readable MiB without collapsing small limits: `Math.round(0.5MB)` renders as
 * "1MB", which misrepresents a configured cap.
 */
export function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 100) return String(Math.round(mib));
  if (mib >= 10) return String(Math.round(mib * 10) / 10);
  return String(Math.round(mib * 100) / 100);
}
