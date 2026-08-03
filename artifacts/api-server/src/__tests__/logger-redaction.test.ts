import { describe, expect, it } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { loggerOptions } from "../lib/logger";

describe("logger redaction", () => {
  it("redacts vercel OIDC and proxy signature headers", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString("utf8"));
        cb();
      },
    });

    const l = pino(loggerOptions, stream);

    l.info({
      req: {
        headers: {
          "x-vercel-oidc-token": "SHOULD_NOT_APPEAR",
          "x-vercel-proxy-signature": "SHOULD_NOT_APPEAR",
          "x-vercel-proxy-signature-ts": "SHOULD_NOT_APPEAR",
        },
      },
    });

    await new Promise<void>((r) => stream.end(() => r()));
    const out = chunks.join("");
    expect(out).not.toContain("SHOULD_NOT_APPEAR");
  });
});
