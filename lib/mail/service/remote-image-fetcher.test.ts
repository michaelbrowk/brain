import type { IncomingHttpHeaders } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SMTP_TEST_CA_CERT,
  SMTP_TEST_SERVER_CERT,
  SMTP_TEST_SERVER_KEY,
  SMTP_TEST_WRONG_HOST_CERT,
  SMTP_TEST_WRONG_HOST_KEY,
} from "../testing/smtp-fixtures";

import {
  CompleteSetRemoteImageDnsResolver,
  PinnedRemoteImageHttpsTransport,
  PinnedRemoteImageFetcher,
  type RemoteImageFetchBudget,
  type RemoteImageDnsResolverPort,
  type RemoteImageTransportPort,
  type RemoteImageTransportResponse,
} from "./remote-image-fetcher";

const FULL_BUDGET: RemoteImageFetchBudget = Object.freeze({
  maxBytes: 8 * 1024 * 1024,
  maxPixels: 12_000_000,
  maxFrames: 100,
});

const httpsServers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    httpsServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("pinned remote mail image HTTPS transport", () => {
  it("dials only the pinned address while verifying the origin hostname", async () => {
    const data = testPng(3, 2);
    let receivedHeaders: IncomingHttpHeaders | undefined;
    let receivedUrl: string | undefined;
    const port = await startHttpsServer(
      SMTP_TEST_SERVER_KEY,
      SMTP_TEST_SERVER_CERT,
      (request, response) => {
        receivedHeaders = request.headers;
        receivedUrl = request.url;
        response.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": String(data.length),
        });
        response.end(data);
      },
    );
    const transport = new PinnedRemoteImageHttpsTransport({
      port,
      certificateAuthority: SMTP_TEST_CA_CERT,
      isForbiddenAddress: () => false,
    });

    const response = await transport.get({
      url: new URL("https://smtp.test.local/banner.png?campaign=one"),
      target: { address: "127.0.0.1", family: 4 },
      headers: Object.freeze({
        Accept: "image/png, image/jpeg, image/gif, image/webp",
        "User-Agent": "Brain-Mail-Image-Proxy/1",
        Connection: "close",
      }),
      deadlineAt: Date.now() + 2_000,
      signal: new AbortController().signal,
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    response.dispose();

    expect(Buffer.concat(chunks)).toEqual(data);
    expect(receivedUrl).toBe("/banner.png?campaign=one");
    expect(receivedHeaders).toMatchObject({
      accept: "image/png, image/jpeg, image/gif, image/webp",
      "user-agent": "Brain-Mail-Image-Proxy/1",
      connection: "close",
      host: "smtp.test.local",
    });
    expect(receivedHeaders).not.toHaveProperty("authorization");
    expect(receivedHeaders).not.toHaveProperty("cookie");
    expect(receivedHeaders).not.toHaveProperty("referer");
    expect(receivedHeaders).not.toHaveProperty("origin");
  });

  it("rejects a valid certificate for the wrong hostname", async () => {
    const port = await startHttpsServer(
      SMTP_TEST_WRONG_HOST_KEY,
      SMTP_TEST_WRONG_HOST_CERT,
      (_request, response) => response.end(testPng(3, 2)),
    );
    const transport = new PinnedRemoteImageHttpsTransport({
      port,
      certificateAuthority: SMTP_TEST_CA_CERT,
      isForbiddenAddress: () => false,
    });

    await expect(
      transport.get({
        url: new URL("https://smtp.test.local/banner.png"),
        target: { address: "127.0.0.1", family: 4 },
        headers: Object.freeze({
          Accept: "image/png, image/jpeg, image/gif, image/webp",
          "User-Agent": "Brain-Mail-Image-Proxy/1",
          Connection: "close",
        }),
        deadlineAt: Date.now() + 2_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      kind: "transient",
      code: "remote_image_transport_unavailable",
    });
  });
});

describe("pinned remote mail image fetcher", () => {
  it("rejects a complete DNS generation when any answer is private", async () => {
    const cancel = vi.fn();
    const resolver = new CompleteSetRemoteImageDnsResolver({
      createLookup: () => ({
        resolve4: async () => [{ address: "93.184.216.34", ttl: 60 }],
        resolve6: async () => [{ address: "::1", ttl: 60 }],
        cancel,
      }),
    });

    await expect(
      resolver.resolve(
        "images.example.com",
        Date.now() + 1_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_target_blocked",
    });
    expect(cancel).toHaveBeenCalled();
  });

  it("revalidates every redirect and sends no browser or account credentials", async () => {
    const resolvedHosts: string[] = [];
    const dns: RemoteImageDnsResolverPort = {
      async resolve(hostname) {
        resolvedHosts.push(hostname);
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const calls: Array<{
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    const disposed: string[] = [];
    const transport: RemoteImageTransportPort = {
      async get(input) {
        calls.push({ url: input.url.toString(), headers: input.headers });
        if (calls.length === 1) {
          return response(
            302,
            { location: "https://cdn.example.net/banner.png" },
            Buffer.alloc(0),
            () => disposed.push("redirect"),
          );
        }
        const data = testPng(3, 2);
        return response(
          200,
          {
            "content-type": "image/png",
            "content-length": String(data.length),
          },
          data,
          () => disposed.push("image"),
        );
      },
    };
    const result = await new PinnedRemoteImageFetcher({ dns, transport }).fetch(
      "https://images.example.com/campaign.png?token=origin-only",
      FULL_BUDGET,
    );

    expect(resolvedHosts).toEqual(["images.example.com", "cdn.example.net"]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://images.example.com/campaign.png?token=origin-only",
      "https://cdn.example.net/banner.png",
    ]);
    for (const call of calls) {
      expect(call.headers).toEqual({
        Accept: "image/png, image/jpeg, image/gif, image/webp",
        "User-Agent": "Brain-Mail-Image-Proxy/1",
        Connection: "close",
      });
      expect(JSON.stringify(call.headers)).not.toMatch(
        /authorization|cookie|referer|origin/i,
      );
    }
    expect(result).toMatchObject({
      mimeType: "image/png",
      raster: { width: 3, height: 2, frames: 1 },
    });
    expect(result.data).toEqual(testPng(3, 2));
    expect(disposed).toEqual(["redirect", "image"]);
    result.data.fill(0);
  });

  it("blocks MIME confusion and one-pixel tracking images", async () => {
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const confused = testPng(3, 2);
    const confusedTransport: RemoteImageTransportPort = {
      async get() {
        return response(
          200,
          { "content-type": "image/jpeg" },
          confused,
        );
      },
    };
    await expect(
      new PinnedRemoteImageFetcher({ dns, transport: confusedTransport }).fetch(
        "https://images.example.com/confused.jpg",
        FULL_BUDGET,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_raster_invalid",
    });

    const pixel = testPng(1, 1);
    const pixelTransport: RemoteImageTransportPort = {
      async get() {
        return response(200, { "content-type": "image/png" }, pixel);
      },
    };
    await expect(
      new PinnedRemoteImageFetcher({ dns, transport: pixelTransport }).fetch(
        "https://images.example.com/open.png",
        FULL_BUDGET,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_tracking_pixel_blocked",
    });
  });

  it("accepts octet-stream only when magic bytes identify one safe raster", async () => {
    const data = testPng(3, 2);
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const transport: RemoteImageTransportPort = {
      async get() {
        return response(
          200,
          {
            "content-type": "application/octet-stream",
            "content-length": String(data.length),
          },
          data,
        );
      },
    };

    const result = await new PinnedRemoteImageFetcher({ dns, transport }).fetch(
      "https://images.example.com/banner",
      FULL_BUDGET,
    );

    expect(result).toMatchObject({
      mimeType: "image/png",
      raster: { width: 3, height: 2, frames: 1 },
    });
    expect(result.data).toEqual(data);
    result.data.fill(0);
  });

  it("keeps non-raster octet-stream responses blocked", async () => {
    const data = Buffer.from("<svg><script>alert(1)</script></svg>");
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const transport: RemoteImageTransportPort = {
      async get() {
        return response(
          200,
          {
            "content-type": "application/octet-stream",
            "content-length": String(data.length),
          },
          data,
        );
      },
    };

    await expect(
      new PinnedRemoteImageFetcher({ dns, transport }).fetch(
        "https://images.example.com/untrusted",
        FULL_BUDGET,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_raster_invalid",
    });
  });

  it("serves the first safe frame when an animated GIF exceeds the pixel budget", async () => {
    const data = testAnimatedGif(400, 400, 100);
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const transport: RemoteImageTransportPort = {
      async get() {
        return response(
          200,
          {
            "content-type": "application/octet-stream",
            "content-length": String(data.length),
          },
          data,
        );
      },
    };

    const result = await new PinnedRemoteImageFetcher({ dns, transport }).fetch(
      "https://images.example.com/animated",
      FULL_BUDGET,
    );

    expect(result).toMatchObject({
      mimeType: "image/gif",
      raster: { width: 400, height: 400, frames: 1 },
    });
    expect(result.data.byteLength).toBeLessThan(data.byteLength);
    result.data.fill(0);
  });

  it("rejects reserved IPv6 answers in a mixed DNS generation", async () => {
    const resolver = new CompleteSetRemoteImageDnsResolver({
      createLookup: () => ({
        resolve4: async () => [{ address: "93.184.216.34", ttl: 60 }],
        resolve6: async () => [{ address: "2001:1000::1", ttl: 60 }],
        cancel: () => undefined,
      }),
    });

    await expect(
      resolver.resolve(
        "images.example.com",
        Date.now() + 1_000,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_target_blocked",
    });
  });

  it("rejects trailing-dot local redirects before another DNS lookup", async () => {
    const dns = {
      resolve: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
    } satisfies RemoteImageDnsResolverPort;
    const transport: RemoteImageTransportPort = {
      async get() {
        return response(
          302,
          { location: "https://foo.local./pixel.png" },
          Buffer.alloc(0),
        );
      },
    };

    await expect(
      new PinnedRemoteImageFetcher({ dns, transport }).fetch(
        "https://images.example.com/banner.png",
        FULL_BUDGET,
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_redirect_invalid",
    });
    expect(dns.resolve).toHaveBeenCalledTimes(1);
  });

  it("enforces the remaining byte budget before reading the body", async () => {
    let reads = 0;
    const data = testPng(3, 2);
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const transport: RemoteImageTransportPort = {
      async get() {
        return {
          statusCode: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(data.length),
          },
          body: (async function* () {
            reads += 1;
            yield data;
          })(),
          dispose: () => undefined,
        };
      },
    };

    await expect(
      new PinnedRemoteImageFetcher({ dns, transport }).fetch(
        "https://images.example.com/banner.png",
        { ...FULL_BUDGET, maxBytes: data.length - 1 },
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_budget_exceeded",
    });
    expect(reads).toBe(0);
  });

  it("enforces the remaining decoded-pixel budget", async () => {
    const data = testPng(4, 4);
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    const transport: RemoteImageTransportPort = {
      async get() {
        return response(200, { "content-type": "image/png" }, data);
      },
    };

    await expect(
      new PinnedRemoteImageFetcher({ dns, transport }).fetch(
        "https://images.example.com/banner.png",
        { ...FULL_BUDGET, maxPixels: 15 },
      ),
    ).rejects.toMatchObject({
      kind: "permanent",
      code: "remote_image_budget_exceeded",
    });
  });

  it("propagates caller aborts through the transport signal", async () => {
    const dns: RemoteImageDnsResolverPort = {
      async resolve() {
        return [{ address: "93.184.216.34", family: 4 }];
      },
    };
    let transportSignal: AbortSignal | null = null;
    let markTransportEntered!: () => void;
    const enteredTransport = new Promise<void>((resolve) => {
      markTransportEntered = resolve;
    });
    const transport: RemoteImageTransportPort = {
      async get(input) {
        transportSignal = input.signal;
        markTransportEntered();
        return await new Promise<RemoteImageTransportResponse>((_resolve, reject) => {
          input.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        });
      },
    };
    const controller = new AbortController();
    const fetch = new PinnedRemoteImageFetcher({ dns, transport }).fetch(
      "https://images.example.com/banner.png",
      FULL_BUDGET,
      controller.signal,
    );
    await enteredTransport;
    controller.abort();

    await expect(fetch).rejects.toMatchObject({
      kind: "transient",
      code: "remote_image_fetch_aborted",
    });
    expect((transportSignal as unknown as AbortSignal).aborted).toBe(true);
  });
});

function response(
  statusCode: number,
  headers: Readonly<Record<string, string>>,
  data: Buffer,
  dispose: () => void = () => undefined,
): RemoteImageTransportResponse {
  return {
    statusCode,
    headers,
    body: chunks(data),
    dispose,
  };
}

async function* chunks(data: Buffer): AsyncIterable<Uint8Array> {
  if (data.length > 0) yield data;
}

function testPng(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function testAnimatedGif(width: number, height: number, frames: number): Buffer {
  const logical = Buffer.alloc(7);
  logical.writeUInt16LE(width, 0);
  logical.writeUInt16LE(height, 2);
  const frame = Buffer.from([
    0x2c, 0, 0, 0, 0,
    width & 0xff, (width >>> 8) & 0xff,
    height & 0xff, (height >>> 8) & 0xff,
    0,
    2,
    2, 0x44, 0x01,
    0,
  ]);
  return Buffer.concat([
    Buffer.from("GIF89a", "ascii"),
    logical,
    ...Array.from({ length: frames }, () => frame),
    Buffer.from([0x3b]),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

async function startHttpsServer(
  key: string,
  cert: string,
  handler: Parameters<typeof createServer>[1],
): Promise<number> {
  const server = createServer({ key, cert }, handler);
  httpsServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return (server.address() as AddressInfo).port;
}
