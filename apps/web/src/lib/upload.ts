import type { EntryMutationResponse, GuestUploadResponse } from "@picoshare/shared";
import { MULTIPART_CHUNK_SIZE_BYTES, MULTIPART_UPLOAD_THRESHOLD_BYTES } from "@picoshare/shared";
import { RequestError, api, handleAuthFailure } from "./api";
import { session } from "./session.svelte";

export type UploadItem = EntryMutationResponse;

/** Without this a stalled connection leaves the view disabled until the page is reloaded. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export type UploadOptions = {
  expirationDays?: number | null;
  note?: string | null;
  onProgress?: (percent: number) => void;
};

type Progress = ((percent: number) => void) | undefined;

function xhrUpload<T>(path: string, method: string, body: FormData, onProgress: Progress): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    if (session.secret) xhr.setRequestHeader("Authorization", session.secret);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let data: { error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText || "{}") as { error?: string };
      } catch {
        // non-JSON error body
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data as T);
        return;
      }
      // Same as api.request: a rotated secret must drop the session, otherwise uploads keep
      // failing while the app still believes it is logged in and the user retries forever.
      if (xhr.status === 401) handleAuthFailure(401);
      reject(new RequestError(data.error || `上传失败 (${xhr.status})`, xhr.status));
    };
    xhr.onerror = () => reject(new RequestError("网络错误，上传失败", 0));
    xhr.ontimeout = () => reject(new RequestError("上传超时，请重试", 0));
    xhr.onabort = () => reject(new RequestError("上传已取消", 0));
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.send(body);
  });
}

async function pushChunks(
  uploadId: string,
  file: File,
  onProgress: Progress,
  chunkSize: number,
): Promise<void> {
  for (let start = 0, part = 1; start < file.size; start += chunkSize, part += 1) {
    const end = Math.min(start + chunkSize, file.size);
    // A raw binary chunk, not JSON or form data. Hono infers a route's input from the typed
    // accessors a handler uses (`c.req.json()`, `c.req.formData()`, …), and this handler reads
    // `request.arrayBuffer()`, which none of them describe — so the typed client has no `body`
    // slot to offer and this one request goes through `fetch`.
    const res = await fetch(
      `/api/entry/multipart/part/${encodeURIComponent(uploadId)}/${part}`,
      {
        method: "POST",
        headers: session.secret ? { Authorization: session.secret } : {},
        body: file.slice(start, end),
      },
    );
    if (!res.ok) {
      // Match `xhrUpload` and `api.request`: a rotated secret has to drop the session, or
      // every later chunk keeps failing while the app still believes it is logged in.
      if (res.status === 401) handleAuthFailure(401);
      throw new RequestError(`分片上传失败 (${res.status})`, res.status);
    }
    onProgress?.(Math.round((end / file.size) * 100));
  }
}

async function multipartUpload(
  file: File,
  opts: UploadOptions,
  target?: { entryId: string; version: number },
): Promise<UploadItem> {
  const init = await api.api.entry.multipart.init.$post({
    json: {
      filename: file.name,
      contentType: file.type || "application/octet-stream",
      size: file.size,
      note: opts.note ?? null,
      expirationDays: opts.expirationDays ?? null,
      entryId: target?.entryId,
      version: target?.version,
    },
  });
  // Honour the chunk size the server asks for: R2 requires every non-final part to be at
  // least 5 MiB, so a smaller shared constant would break every large upload.
  const chunkSize = init.chunkSize || MULTIPART_CHUNK_SIZE_BYTES;
  opts.onProgress?.(0);
  try {
    await pushChunks(init.uploadId, file, opts.onProgress, chunkSize);
    return await api.api.entry.multipart.complete.$post({ json: { uploadId: init.uploadId } });
  } catch (err) {
    await api.api.entry.multipart.abort.$post({ json: { uploadId: init.uploadId } }).catch(() => {});
    throw err;
  }
}

const metadataFields = (opts: UploadOptions, fd: FormData): FormData => {
  fd.set("note", opts.note ?? "");
  fd.set("expirationDays", String(opts.expirationDays ?? ""));
  return fd;
};

export async function uploadFiles(
  files: File[],
  pastedText: string,
  opts: UploadOptions = {},
): Promise<UploadItem[]> {
  const items: UploadItem[] = [];
  for (const file of files) {
    opts.onProgress?.(0);
    items.push(
      file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES
        ? await multipartUpload(file, opts)
        : await (async () => {
            const fd = metadataFields(opts, new FormData());
            fd.set("file", file, file.name);
            return await xhrUpload<UploadItem>("/api/entry", "POST", fd, opts.onProgress);
          })(),
    );
    opts.onProgress?.(100);
  }
  if (pastedText.trim()) {
    const fd = metadataFields(opts, new FormData());
    fd.set("pastedText", pastedText);
    items.push(await xhrUpload<UploadItem>("/api/entry", "POST", fd, opts.onProgress));
  }
  return items;
}

export async function replaceContent(
  entryId: string,
  version: number,
  file: File,
  onProgress?: Progress,
): Promise<UploadItem> {
  if (file.size >= MULTIPART_UPLOAD_THRESHOLD_BYTES) {
    return await multipartUpload(file, { onProgress }, { entryId, version });
  }
  const fd = new FormData();
  fd.set("file", file, file.name);
  fd.set("version", String(version));
  return await xhrUpload<UploadItem>(
    `/api/entry/${encodeURIComponent(entryId)}/content`,
    "PUT",
    fd,
    onProgress,
  );
}

export async function guestUpload(
  guestId: string,
  files: File[],
  pastedText: string,
  note: string,
  onProgress: Progress,
): Promise<GuestUploadResponse> {
  const fd = new FormData();
  for (const file of files) fd.append("files", file, file.name);
  if (pastedText.trim()) fd.set("pastedText", pastedText);
  if (note) fd.set("note", note);
  return await xhrUpload(
    `/api/guest/${encodeURIComponent(guestId)}/upload`,
    "POST",
    fd,
    onProgress,
  );
}
