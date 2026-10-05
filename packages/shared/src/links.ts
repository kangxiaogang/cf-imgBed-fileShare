import { isImageContentType } from "./media";

export const shortLinkPath = (id: string): string => `/-${encodeURIComponent(id)}`;

export const guestUrlPath = (id: string): string => `/guest/${encodeURIComponent(id)}`;

export const imageLinkPath = (id: string, filename: string): string =>
  `/img/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;

export const entryUrlPath = (
  id: string,
  filename: string,
  contentType?: string | null,
): string => (isImageContentType(contentType) ? imageLinkPath(id, filename) : shortLinkPath(id));

export const markdownLink = (url: string, label: string): string =>
  `[${label.replaceAll("]", "\\]")}](${url})`;

export const bbcodeLink = (url: string): string => `[url]${url}[/url]`;

export const markdownImage = (url: string, alt: string): string =>
  `![${alt.replaceAll("]", "\\]")}](${url})`;

export const htmlImage = (url: string, alt: string): string =>
  `<img src="${url}" alt="${alt.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}" />`;

export const bbcodeImage = (url: string): string => `[img]${url}[/img]`;

export const absoluteUrl = (origin: string, path: string): string => `${origin.replace(/\/$/, "")}${path}`;
