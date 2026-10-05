import { HASH_LIMIT_BYTES } from "@picoshare/shared";
import { generateID } from "./id";
import { sha256Hex } from "./hash";
import type { Env } from "../types";

/*
 * The R2 key convention, and the one operation on stored bytes that needs a size guard.
 *
 * Deliberately not a wrapper around `env.BUCKET.*`: forwarding a four-argument call through
 * a one-argument function adds a file without adding safety. What is worth centralising is
 * the key layout, because three call sites derive keys and a collision there is silent
 * data loss.
 */

/** Version 1 sits at the bare entry id, so the overwhelmingly common case has no path segment. */
export const firstObjectKey = (entryId: string): string => entryId;

/**
 * The key an archived version is copied to. Deterministic, and only ever written by the
 * snapshot that replaces it.
 */
export const archiveKey = (entryId: string, version: number): string => `${entryId}/versions/${version}`;

/**
 * The key newly written content is staged under. Randomised because a replacement retries,
 * and a deterministic key would let a failed attempt's leftover object be picked up as if it
 * were the new content.
 */
export const freshVersionKey = (entryId: string, version: number): string =>
  `${archiveKey(entryId, version)}-${generateID()}`;

export function maybeHash(
  bytes: ArrayBuffer | Uint8Array,
  size: number,
): Promise<string | null> {
  return size <= HASH_LIMIT_BYTES ? sha256Hex(bytes) : Promise.resolve(null);
}

/**
 * Hash an object already in the bucket. Used by the chunked-upload path, which has no bytes
 * in hand after `complete()`.
 */
export async function hashObject(env: Env, key: string, size: number): Promise<string | null> {
  if (size > HASH_LIMIT_BYTES) return null;
  const object = await env.BUCKET.get(key);
  return object ? sha256Hex(await object.arrayBuffer()) : null;
}
