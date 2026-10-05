/**
 * A row of the `entries` table, and nothing else. The list and detail responses add a
 * computed `download_count`, which is why they are separate types: keeping it optional here
 * meant a list that stopped selecting the count still type-checked, and every consumer had to
 * write `?? 0` to cover a field that is always present.
 */
export type Entry = {
  id: string;
  filename: string;
  content_type: string | null;
  size: number;
  sha256: string | null;
  version: number;
  upload_time: string;
  updated_time: string;
  expiration_time: string | null;
  note: string | null;
  guest_link_id: string | null;
  /**
   * A share link that currently works, for handing this entry to somebody else. Null when every
   * share has been revoked or has expired — the entry is still there, it just cannot be given out.
   *
   * Computed rather than stored, and read by seven call sites that used to pass `id` straight to
   * a link builder. Making it a real column instead would mean the list and detail queries stop
   * agreeing with the shares table the moment one is revoked.
   */
  share_id: string | null;
};

/**
 * One share link: a revocable, expiring handle on an entry.
 *
 * `expires_at` bounds the *link*, never the file. That is the distinction the whole table exists
 * to make possible — an expired share answers 410 and leaves the entry and its bytes alone.
 */
export type Share = {
  id: string;
  entry_id: string;
  /** The creator's private note about who this link is for. Never sent to the visitor. */
  label: string | null;
  expires_at: string | null;
  created_time: string;
};

// `GET /api/entry/:id/shares` answers with the array itself, not an object wrapping it, so
// there is deliberately no `EntrySharesResponse` here. The one that was declared described a
// shape nothing returns and nothing read, and a route response belongs to `app.ts` anyway —
// the client's type is inferred from the registration, which is why a wrong type here would
// have compiled cleanly while misleading the next person to read it.

export type EntryListItem = Entry & { download_count: number };

export type EntryDetailResponse = EntryListItem;

export type EntryVersionsResponse = { versions: FileVersion[] };

export type FileVersion = {
  entry_id: string;
  version: number;
  filename: string;
  content_type: string | null;
  size: number;
  sha256: string | null;
  created_time: string;
};

export type GuestLink = {
  id: string;
  label: string | null;
  created_time: string;
  /** Never null: the column is NOT NULL and always carries a real default cap. */
  max_file_bytes: number;
  max_file_lifetime_days: number | null;
  max_file_uploads: number | null;
  url_expires: string | null;
  upload_count: number;
  entry_count: number;
};

/**
 * What a guest is told about the link they are uploading through.
 *
 * Deliberately narrower than `GuestLink`: `label` is the creator's private note, so it is
 * not disclosed. `url_expires` is, because knowing when your own access ends is not a leak.
 * This response used to be emitted as camelCase (`maxFileBytes`) while the upload view read
 * snake_case off a `GuestLink`, so every field resolved to undefined and the page rendered
 * "大小不限" for a cap that was being enforced server-side.
 */
export type GuestInfo = {
  /** Never null: see `GuestLink.max_file_bytes`. */
  max_file_bytes: number;
  max_file_lifetime_days: number | null;
  max_file_uploads: number | null;
  remaining_uploads: number | null;
  max_files: number;
  url_expires: string | null;
};

export type Settings = {
  storeForever: boolean;
  defaultDays: number;
};

export type SystemInfo = {
  upload_data_bytes: number;
  entry_count: number;
  guest_link_count: number;
  download_count: number;
};

export type DownloadEvent = {
  downloaded_at: string;
  ip: string | null;
  user_agent: string | null;
};

export type MultipartInitRequest = {
  filename: string;
  contentType: string;
  size: number;
  note: string | null;
  expirationDays: number | null;
  entryId?: string;
  version?: number;
};

export type MultipartInitResponse = {
  uploadId: string;
  id: string;
  chunkSize: number;
};

/**
 * What an upload hands back.
 *
 * The three link fields are null for anything that is not an image. A hosted image has to come
 * back with a usable URL — that is the contract `POST /api/entry` exists for — but a file in
 * somebody's library is not public until they choose to share it, and answering with a link
 * nobody asked for is how a permanent public URL sneaks back in. The owner's route to a file's
 * link is its share page.
 */
export type EntryMutationResponse = {
  id: string;
  filename: string;
  version: number;
  sha256: string | null;
  url: string | null;
  markdown: string | null;
  bbcode: string | null;
  deduped: boolean;
};

export type EntryListResponse = {
  items: EntryListItem[];
  total: number;
};

export type OkResponse = { ok: true };

export type BulkDeleteResponse = { ok: true; deleted: number };

export type UpdateMetadataResponse = { ok: true; filename: string };

export type EntryDownloadsResponse = {
  total: number;
  events: DownloadEvent[];
};

export type GuestUploadItem = EntryMutationResponse & { contentType: string };

export type GuestUploadResponse = {
  count: number;
  items: GuestUploadItem[];
  upload_count: number;
  deduped: number;
};
