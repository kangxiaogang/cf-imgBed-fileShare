export const MULTIPART_CHUNK_SIZE_BYTES = 8 * 1024 * 1024;
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 100 * 1024 * 1024;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_LABEL_LENGTH = 120;
export const MAX_EXPIRATION_DAYS = 3650;
/**
 * Days a file gets when nothing has been configured.
 *
 * This was the literal `30` written out three times — the seed row in `schema.sql`, the server's
 * fallback when that row is missing or unreadable, and the control that prefills the upload form.
 * Two of those had already drifted in a way nobody could see: the control's copy was read once,
 * when the component was created, which on the upload form is *before* the settings page's value
 * has arrived — so ticking the box offered 30 while the settings page said 14. One constant, so
 * that a change lands in all of them.
 *
 * `schema.sql` seeds its row with the same number and cannot import this; the two are held
 * together by `contract.test.ts`.
 */
export const DEFAULT_EXPIRATION_DAYS = 14;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 50;
/** Most files one guest upload request may carry. The authenticated upload path is uncapped. */
export const MAX_GUEST_UPLOAD_FILES = 20;

/** Largest body the non-multipart endpoints accept, matching the multipart threshold. */
export const MAX_SINGLE_UPLOAD_BYTES = MULTIPART_UPLOAD_THRESHOLD_BYTES;
/** Slack for multipart framing, part headers and the note field around a file upload. */
export const FORM_UPLOAD_OVERHEAD_BYTES = 1024 * 1024;
/** Largest form-encoded body; `formData()` buffers it whole inside the isolate. */
export const MAX_FORM_UPLOAD_BYTES = MAX_SINGLE_UPLOAD_BYTES + FORM_UPLOAD_OVERHEAD_BYTES;
/** Aggregate cap for one guest upload request (all files plus pasted text). */
export const MAX_GUEST_REQUEST_BYTES = 64 * 1024 * 1024;
/** Default per-file cap for a guest link that does not specify one. */
export const MAX_GUEST_FILE_BYTES = MAX_GUEST_REQUEST_BYTES;
/** Default number of files a guest link may ever receive. */
export const MAX_GUEST_UPLOADS = 200;
/** Longest pasted-text payload accepted, stored as a real file. */
export const MAX_PASTE_LENGTH = 1 * 1024 * 1024;
/**
 * Largest object that is SHA-256 hashed for deduplication. `crypto.subtle.digest` is
 * one-shot, so hashing means buffering the whole object inside the isolate — anything
 * larger (which includes every multipart upload, since those start at
 * `MULTIPART_UPLOAD_THRESHOLD_BYTES`) is stored with a `null` hash and is not deduplicated.
 */
export const HASH_LIMIT_BYTES = 32 * 1024 * 1024;
