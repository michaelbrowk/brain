import { describe, expect, it, vi } from "vitest";

import { CompleteSetMailDnsResolver } from "./dns";

describe("complete-set mail DNS", () => {
  it("accepts ENODATA for one family and pins every public answer", async () => {
    const cancel = vi.fn();
    const resolver = new CompleteSetMailDnsResolver({
      now: () => 1_000,
      createLookup: () => ({
        resolve4: async () => [{ address: "93.184.216.34", ttl: 60 }],
        resolve6: async () => {
          throw Object.assign(new Error("no IPv6"), { code: "ENODATA" });
        },
        cancel,
      }),
    });

    await expect(
      resolver.resolve(
        "imap",
        { hostname: "imap.example.test", port: 993, tls: "implicit" },
        11_000,
      ),
    ).resolves.toMatchObject([
      {
        address: "93.184.216.34",
        family: 4,
        hostname: "imap.example.test",
        expiresAt: 11_000,
      },
    ]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("fails the whole generation on NXDOMAIN from either family", async () => {
    const cancel = vi.fn();
    const resolver = new CompleteSetMailDnsResolver({
      now: () => 1_000,
      createLookup: () => ({
        resolve4: async () => [{ address: "93.184.216.34", ttl: 60 }],
        resolve6: async () => {
          throw Object.assign(new Error("secret provider response"), {
            code: "ENOTFOUND",
          });
        },
        cancel,
      }),
    });

    await expect(
      resolver.resolve(
        "imap",
        { hostname: "imap.example.test", port: 993, tls: "implicit" },
        11_000,
      ),
    ).rejects.toMatchObject({ code: "imap_dns_failed", message: "imap_dns_failed" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects the complete set if any answer is private", async () => {
    const cancel = vi.fn();
    const resolver = new CompleteSetMailDnsResolver({
      now: () => 1_000,
      createLookup: () => ({
        resolve4: async () => [
          { address: "93.184.216.34", ttl: 60 },
          { address: "127.0.0.1", ttl: 60 },
        ],
        resolve6: async () => {
          throw Object.assign(new Error("none"), { code: "ENODATA" });
        },
        cancel,
      }),
    });

    await expect(
      resolver.resolve(
        "imap",
        { hostname: "imap.example.test", port: 993, tls: "implicit" },
        11_000,
      ),
    ).rejects.toMatchObject({ code: "imap_dns_failed" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels both family lookups when the request aborts", async () => {
    const cancel = vi.fn();
    const held = new Promise<never>(() => undefined);
    const controller = new AbortController();
    const resolver = new CompleteSetMailDnsResolver({
      now: () => 1_000,
      createLookup: () => ({
        resolve4: () => held,
        resolve6: () => held,
        cancel,
      }),
    });
    const result = resolver.resolve(
      "imap",
      { hostname: "imap.example.test", port: 993, tls: "implicit" },
      11_000,
      controller.signal,
    );
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(cancel).toHaveBeenCalled();
  });
});
