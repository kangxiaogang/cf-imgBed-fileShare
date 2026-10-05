import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createEnv } from "./helpers";

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as never;

describe("worker entrypoint", () => {
  it("keeps the tracked worker config free of any secret", () => {
    // Every value in this repository is public, so a secret left in a tracked file is a published
    // secret — nothing at runtime would notice it, since the entrypoint has no notion of a
    // configured or a placeholder secret. The config was never read by a test before, so nothing
    // would have seen one arrive; this is the same shape the CI secret scan looks for,
    // deliberately, so the two cannot drift into checking different things.
    const config = readFileSync("wrangler.jsonc", "utf8");

    expect(config).not.toMatch(/PS_SHARED_SECRET["']?\s*[:=]\s*["']?[A-Za-z0-9_./+-]{8,}/);
  });

  it("serves normally with a real secret", async () => {
    const res = await worker.fetch(
      new Request("https://x/api/entries", { headers: { Authorization: "s3cret" } }),
      createEnv({ secret: "s3cret" }),
      ctx(),
    );
    expect(res.status).toBe(200);
  });

  it("never leaves the scheduled maintenance as an unhandled rejection", async () => {
    const promises: Array<Promise<unknown>> = [];
    const env = createEnv({
      secret: "s3cret",
      run: () => {
        throw new Error("d1 down");
      },
    });
    worker.scheduled!({} as never, env, {
      waitUntil: (p: Promise<unknown>) => promises.push(p),
    } as never);
    await expect(Promise.all(promises)).resolves.toBeDefined();
  });
});
