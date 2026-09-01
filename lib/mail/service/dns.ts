import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";

import type {
  MailDnsResolverPort,
  MailEndpoint,
  MailProtocol,
  ValidatedMailDialTarget,
} from "../ports";
import {
  MAIL_MAX_DNS_GENERATION_AGE_MS,
  validateResolvedMailTargets,
} from "../security";
import { MailAccountError } from "./account-types";

interface DnsAddressRecord {
  readonly address: string;
  readonly ttl: number;
}

interface ResolvedAddressRecord extends DnsAddressRecord {
  readonly family: 4 | 6;
}

interface MailDnsLookup {
  resolve4(hostname: string): Promise<readonly DnsAddressRecord[]>;
  resolve6(hostname: string): Promise<readonly DnsAddressRecord[]>;
  cancel(): void;
}

export class CompleteSetMailDnsResolver implements MailDnsResolverPort {
  private readonly createLookup: () => MailDnsLookup;
  private readonly now: () => number;

  constructor(options?: {
    readonly createLookup?: () => MailDnsLookup;
    readonly now?: () => number;
  }) {
    this.createLookup = options?.createLookup ?? createNodeLookup;
    this.now = options?.now ?? Date.now;
  }

  async resolve(
    protocol: MailProtocol,
    endpoint: MailEndpoint,
    deadlineAt: number,
    signal?: AbortSignal,
  ): Promise<readonly ValidatedMailDialTarget[]> {
    const startedAt = this.now();
    if (
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt <= startedAt ||
      signal?.aborted
    ) {
      throw new MailAccountError("imap_connection_timeout");
    }
    const lookup = this.createLookup();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    try {
      const [ipv4, ipv6] = await Promise.race([
        Promise.all([
          resolveFamily(lookup.resolve4(endpoint.hostname), 4),
          resolveFamily(lookup.resolve6(endpoint.hostname), 6),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            lookup.cancel();
            reject(new MailAccountError("imap_connection_timeout"));
          }, Math.max(0, deadlineAt - this.now()));
        }),
        new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          abortHandler = () => {
            lookup.cancel();
            reject(new MailAccountError("imap_connection_timeout"));
          };
          signal.addEventListener("abort", abortHandler, { once: true });
          if (signal.aborted) abortHandler();
        }),
      ]);
      const records = [...ipv4, ...ipv6];
      if (records.length === 0) {
        throw new MailAccountError("imap_dns_failed");
      }
      const now = this.now();
      if (now >= deadlineAt || signal?.aborted) {
        throw new MailAccountError("imap_connection_timeout");
      }
      const ttlMs = Math.min(
        MAIL_MAX_DNS_GENERATION_AGE_MS,
        ...records.map((record) => Math.max(1_000, record.ttl * 1_000)),
      );
      const targets = validateResolvedMailTargets(
        protocol,
        endpoint,
        {
          resolutionId: `dns-r${randomBytes(16).toString("hex")}`,
          resolvedAt: now,
          expiresAt: Math.min(now + ttlMs, deadlineAt),
          addresses: records.map((record) => ({
            address: record.address,
            family: record.family,
          })),
        },
        now,
      );
      if (signal?.aborted) {
        throw new MailAccountError("imap_connection_timeout");
      }
      return targets;
    } catch (error) {
      lookup.cancel();
      if (error instanceof MailAccountError) throw error;
      throw new MailAccountError("imap_dns_failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && abortHandler) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
  }
}

async function resolveFamily(
  request: Promise<readonly DnsAddressRecord[]>,
  family: 4 | 6,
): Promise<readonly ResolvedAddressRecord[]> {
  try {
    return (await request).map((record) => Object.freeze({ ...record, family }));
  } catch (error) {
    if (isNoDataError(error)) return [];
    throw error;
  }
}

function createNodeLookup(): MailDnsLookup {
  const resolver = new Resolver();
  return {
    resolve4: async (hostname) =>
      resolver.resolve4(hostname, { ttl: true }) as Promise<DnsAddressRecord[]>,
    resolve6: async (hostname) =>
      resolver.resolve6(hostname, { ttl: true }) as Promise<DnsAddressRecord[]>,
    cancel: () => resolver.cancel(),
  };
}

function isNoDataError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENODATA";
}
