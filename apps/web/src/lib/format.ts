import {
  absoluteUrl,
  guestUrlPath,
  imageLinkPath,
  shortLinkPath,
} from "@picoshare/shared";

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 1048575 bytes lands on 1023.999 KB, which toFixed(0) would render as "1024 KB".
  if (unit > 0 && unit < units.length - 1 && value >= 1023.5) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Date(time).toLocaleString("zh-CN", { hour12: false });
}

/**
 * The public link for a share. `shareId` is `entry.share_id`, never `entry.id` — the entry id
 * stopped being the credential when shares arrived, and passing it here yields a 404 that looks
 * like a broken image rather than a wrong argument.
 */
export const shortLink = (shareId: string): string =>
  absoluteUrl(window.location.origin, shortLinkPath(shareId));

export const imageLink = (shareId: string, filename: string): string =>
  absoluteUrl(window.location.origin, imageLinkPath(shareId, filename));

export const guestUrl = (id: string): string => absoluteUrl(window.location.origin, guestUrlPath(id));
