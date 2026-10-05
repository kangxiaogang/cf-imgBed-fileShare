import type { Entry, FileVersion, GuestLink } from "@picoshare/shared";

export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  PS_SHARED_SECRET: string;
  /** Origin used for generated share links; falls back to the request's own origin. */
  PUBLIC_ORIGIN?: string;
}

/**
 * Row shapes.
 *
 * `EntryRow` is the public `Entry` plus the one internal column. Keeping it a superset of the
 * response type means a read path has no mapping layer, so the only way a column can drift
 * from the response is a contract test failing — not a hand-written projection quietly
 * dropping a field that a client started reading.
 */
/**
 * A row of the `entries` table: `Entry` plus the one column the API never sees.
 *
 * The `Omit` is load-bearing. `Entry` carries `share_id`, which is looked up in `shares` and
 * is not a column here — and this type is what keeps that honest. Deriving it as
 * `Entry & { object_key }` made every read path claim to have read a column that does not
 * exist, which is the one mistake a structural type cannot catch on its own.
 */
export type EntryRow = Omit<Entry, "share_id"> & { object_key: string };

export type VersionRow = FileVersion & { object_key: string };

/** A `guest_links` row, without the `entry_count` the list view adds. */
export type GuestLinkRow = Omit<GuestLink, "entry_count">;

export type UploadState = "pending" | "completing";

/** A row of `upload_sessions`: one in-flight chunked upload. */
export type UploadSessionRow = {
  id: string;
  entry_id: string | null;
  is_replace: number;
  expected_version: number | null;
  filename: string;
  content_type: string;
  size: number;
  object_key: string;
  note: string | null;
  expiration_time: string | null;
  state: UploadState;
};
