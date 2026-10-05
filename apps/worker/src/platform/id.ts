const CHARS = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// 2^32 is not a multiple of CHARS.length, so the tail of the range would be picked
// slightly more often. Reject it to keep every character equally likely.
const UNBIASED_LIMIT = Math.floor(0x1_0000_0000 / CHARS.length) * CHARS.length;

export const ENTRY_ID_LENGTH = 16;

/**
 * Entry and guest-link IDs double as the unauthenticated access token for
 * `/-<id>` and `/img/<id>/<name>`, so they must come from a CSPRNG:
 * `Math.random()` is a predictable xorshift128+ whose state can be recovered from
 * a handful of observed outputs.
 */
export const generateID = (length = ENTRY_ID_LENGTH): string => {
  let out = "";
  const buf = new Uint32Array(Math.max(1, length));
  while (out.length < length) {
    crypto.getRandomValues(buf);
    for (const value of buf) {
      if (value >= UNBIASED_LIMIT) continue;
      out += CHARS[value % CHARS.length];
      if (out.length === length) break;
    }
  }
  return out;
};
