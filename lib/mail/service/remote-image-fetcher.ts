import { Resolver } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import {
  isIP,
  SocketAddress,
  type LookupFunction,
} from "node:net";

import { MAIL_INLINE_IMAGE_MAX_BYTES } from "../content-types";
import {
  extractFirstGifFrame,
  inspectMailRaster,
  type VerifiedMailRaster,
} from "../raster-metadata";
import {
  isForbiddenResolvedAddress,
  MAIL_RESOURCE_LIMITS,
  validateMailRemoteImageSourceUrl,
} from "../security";

const REMOTE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const REMOTE_IMAGE_GENERIC_MIME_TYPE = "application/octet-stream";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

interface DnsAddressRecord {
  readonly address: string;
  readonly ttl: number;
}

export interface RemoteImageDialTarget {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface RemoteImageDnsResolverPort {
  resolve(
    hostname: string,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<readonly RemoteImageDialTarget[]>;
}

export interface RemoteImageTransportResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
  dispose(): void;
}

export interface RemoteImageTransportPort {
  get(input: {
    readonly url: URL;
    readonly target: RemoteImageDialTarget;
    readonly headers: Readonly<Record<string, string>>;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<RemoteImageTransportResponse>;
}

export interface RemoteImageFetchResult {
  readonly mimeType: string;
  readonly data: Buffer;
  readonly raster: VerifiedMailRaster;
}

export interface RemoteImageFetchBudget {
  readonly maxBytes: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
}

export interface RemoteImageFetcherPort {
  fetch(
    sourceUrl: string,
    budget: RemoteImageFetchBudget,
    signal?: AbortSignal,
  ): Promise<RemoteImageFetchResult>;
}

export class RemoteImageFetchError extends Error {
  constructor(
    readonly kind: "transient" | "permanent",
    readonly code: string,
  ) {
    super(code);
    this.name = "RemoteImageFetchError";
  }
}

/** Resolves the complete A+AAAA set and rejects the whole generation if any IP is unsafe. */
export class CompleteSetRemoteImageDnsResolver
  implements RemoteImageDnsResolverPort
{
  private readonly createLookup: () => {
    resolve4(hostname: string): Promise<readonly DnsAddressRecord[]>;
    resolve6(hostname: string): Promise<readonly DnsAddressRecord[]>;
    cancel(): void;
  };

  constructor(options?: {
    readonly createLookup?: CompleteSetRemoteImageDnsResolver["createLookup"];
  }) {
    this.createLookup = options?.createLookup ?? createNodeLookup;
  }

  async resolve(
    hostname: string,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<readonly RemoteImageDialTarget[]> {
    if (
      typeof hostname !== "string" ||
      hostname.length === 0 ||
      !Number.isSafeInteger(deadlineAt) ||
      deadlineAt <= Date.now() ||
      signal.aborted
    ) {
      throw transient("remote_image_dns_unavailable");
    }
    const lookup = this.createLookup();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => lookup.cancel();
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [ipv4, ipv6] = await Promise.race([
        Promise.all([
          resolveFamily(lookup.resolve4(hostname), 4),
          resolveFamily(lookup.resolve6(hostname), 6),
        ]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              lookup.cancel();
              reject(transient("remote_image_dns_unavailable"));
            },
            Math.max(1, deadlineAt - Date.now()),
          );
          timer.unref?.();
        }),
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(transient("remote_image_fetch_aborted")),
            { once: true },
          );
        }),
      ]);
      const records = [...ipv4, ...ipv6];
      if (
        records.length === 0 ||
        records.length > MAIL_RESOURCE_LIMITS.maxDnsAnswers
      ) {
        throw transient("remote_image_dns_unavailable");
      }
      const unique = new Set<string>();
      const targets = records.map((record) => {
        const address = canonicalAddress(record.address, record.family);
        if (address === null || isForbiddenResolvedAddress(address)) {
          throw permanent("remote_image_target_blocked");
        }
        const key = `${record.family}:${address}`;
        if (unique.has(key)) throw permanent("remote_image_target_blocked");
        unique.add(key);
        return Object.freeze({ address, family: record.family });
      });
      if (signal.aborted || Date.now() >= deadlineAt) {
        throw transient("remote_image_fetch_aborted");
      }
      return Object.freeze(
        targets.sort(
          (left, right) =>
            left.family - right.family || left.address.localeCompare(right.address),
        ),
      );
    } catch (error) {
      if (error instanceof RemoteImageFetchError) throw error;
      throw transient("remote_image_dns_unavailable");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      lookup.cancel();
    }
  }
}

/** HTTPS transport with hostname TLS verification and one prevalidated pinned IP. */
export class PinnedRemoteImageHttpsTransport
  implements RemoteImageTransportPort
{
  private readonly request: typeof httpsRequest;
  private readonly port: number;
  private readonly certificateAuthority: RequestOptions["ca"];
  private readonly isForbiddenAddress: (address: string) => boolean;

  constructor(options: {
    readonly request?: typeof httpsRequest;
    readonly port?: number;
    readonly certificateAuthority?: RequestOptions["ca"];
    readonly isForbiddenAddress?: (address: string) => boolean;
  } = {}) {
    this.request = options.request ?? httpsRequest;
    this.port = options.port ?? 443;
    this.certificateAuthority = options.certificateAuthority;
    this.isForbiddenAddress =
      options.isForbiddenAddress ?? isForbiddenResolvedAddress;
    if (
      typeof this.request !== "function" ||
      !Number.isSafeInteger(this.port) ||
      this.port < 1 ||
      this.port > 65_535 ||
      typeof this.isForbiddenAddress !== "function"
    ) {
      throw permanent("remote_image_transport_invalid");
    }
  }

  async get(input: {
    readonly url: URL;
    readonly target: RemoteImageDialTarget;
    readonly headers: Readonly<Record<string, string>>;
    readonly deadlineAt: number;
    readonly signal: AbortSignal;
  }): Promise<RemoteImageTransportResponse> {
    const targetAddress = canonicalAddress(
      input.target.address,
      input.target.family,
    );
    if (
      input.url.protocol !== "https:" ||
      targetAddress === null ||
      this.isForbiddenAddress(targetAddress) ||
      input.signal.aborted ||
      input.deadlineAt <= Date.now()
    ) {
      throw permanent("remote_image_target_blocked");
    }
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all) {
        callback(null, [
          { address: targetAddress, family: input.target.family },
        ]);
      } else {
        callback(null, targetAddress, input.target.family);
      }
    };
    return new Promise<RemoteImageTransportResponse>((resolve, reject) => {
      let settled = false;
      const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
      const finishError = (error: RemoteImageFetchError) => {
        if (settled) return;
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        reject(error);
      };
      const options: RequestOptions = {
        protocol: "https:",
        hostname: input.url.hostname,
        port: this.port,
        method: "GET",
        path: `${input.url.pathname}${input.url.search}`,
        agent: false,
        servername: input.url.hostname,
        rejectUnauthorized: true,
        ...(this.certificateAuthority === undefined
          ? {}
          : { ca: this.certificateAuthority }),
        lookup,
        signal: input.signal,
        headers: remoteImageRequestHeaders(input.headers, input.url.hostname),
      };
      const request = this.request(options, (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        const remoteAddress = response.socket.remoteAddress;
        const remoteFamily = response.socket.remoteFamily;
        const canonicalRemote =
          typeof remoteAddress === "string" &&
          (remoteFamily === "IPv4" || remoteFamily === "IPv6")
            ? canonicalAddress(
                remoteAddress,
                remoteFamily === "IPv4" ? 4 : 6,
              )
            : null;
        if (canonicalRemote !== targetAddress) {
          response.destroy();
          finishError(permanent("remote_image_dial_mismatch"));
          return;
        }
        settled = true;
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        resolve(
          Object.freeze({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: response,
            dispose: () => response.destroy(),
          }),
        );
      });
      request.once("error", (error) => {
        finishError(
          error instanceof RemoteImageFetchError
            ? error
            : transient("remote_image_transport_unavailable"),
        );
      });
      timerRef.current = setTimeout(() => {
        request.destroy();
        finishError(transient("remote_image_fetch_timeout"));
      }, Math.max(1, input.deadlineAt - Date.now()));
      timerRef.current.unref?.();
      request.end();
    });
  }
}

export class PinnedRemoteImageFetcher implements RemoteImageFetcherPort {
  private readonly dns: RemoteImageDnsResolverPort;
  private readonly transport: RemoteImageTransportPort;

  constructor(options?: {
    readonly dns?: RemoteImageDnsResolverPort;
    readonly transport?: RemoteImageTransportPort;
  }) {
    this.dns = options?.dns ?? new CompleteSetRemoteImageDnsResolver();
    this.transport = options?.transport ?? new PinnedRemoteImageHttpsTransport();
  }

  async fetch(
    sourceUrl: string,
    budget: RemoteImageFetchBudget,
    signal?: AbortSignal,
  ): Promise<RemoteImageFetchResult> {
    let normalized: string;
    try {
      normalized = validateMailRemoteImageSourceUrl(sourceUrl);
    } catch {
      throw permanent("remote_image_url_invalid");
    }
    const validatedBudget = validateFetchBudget(budget);
    if (signal?.aborted) {
      throw transient("remote_image_fetch_aborted");
    }
    const startedAt = Date.now();
    const deadlineAt = startedAt + MAIL_RESOURCE_LIMITS.remoteImageFetchDeadlineMs;
    const controller = new AbortController();
    let abortedByCaller = false;
    let timedOut = false;
    const abortFromCaller = () => {
      abortedByCaller = true;
      controller.abort();
    };
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, deadlineAt - startedAt));
    timer.unref?.();
    try {
      let current = new URL(normalized);
      for (
        let redirects = 0;
        redirects <= MAIL_RESOURCE_LIMITS.remoteImageMaxRedirects;
        redirects += 1
      ) {
        const targets = await this.dns.resolve(
          current.hostname,
          deadlineAt,
          controller.signal,
        );
        const target = targets[0];
        if (target === undefined) throw transient("remote_image_dns_unavailable");
        const response = await this.transport.get({
          url: current,
          target,
          headers: Object.freeze({
            Accept: "image/png, image/jpeg, image/gif, image/webp",
            "User-Agent": "Brain-Mail-Image-Proxy/1",
            Connection: "close",
          }),
          deadlineAt,
          signal: controller.signal,
        });
        try {
          if (REDIRECT_STATUS.has(response.statusCode)) {
            if (redirects >= MAIL_RESOURCE_LIMITS.remoteImageMaxRedirects) {
              throw permanent("remote_image_redirect_limit");
            }
            current = redirectTarget(current, response.headers.location);
            continue;
          }
          if (response.statusCode !== 200) {
            throw response.statusCode === 429 || response.statusCode >= 500
              ? transient("remote_image_origin_unavailable")
              : permanent("remote_image_origin_rejected");
          }
          return await collectVerifiedImage(
            response,
            deadlineAt,
            controller.signal,
            validatedBudget,
          );
        } finally {
          response.dispose();
        }
      }
      throw permanent("remote_image_redirect_limit");
    } catch (error) {
      if (controller.signal.aborted) {
        throw transient(
          abortedByCaller && !timedOut
            ? "remote_image_fetch_aborted"
            : "remote_image_fetch_timeout",
        );
      }
      if (error instanceof RemoteImageFetchError) throw error;
      throw transient("remote_image_transport_unavailable");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
      controller.abort();
    }
  }

}

function remoteImageRequestHeaders(
  value: Readonly<Record<string, string>>,
  hostname: string,
): Readonly<Record<string, string>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "Accept,Connection,User-Agent" ||
    value.Accept !== "image/png, image/jpeg, image/gif, image/webp" ||
    value["User-Agent"] !== "Brain-Mail-Image-Proxy/1" ||
    value.Connection !== "close"
  ) {
    throw permanent("remote_image_transport_headers_invalid");
  }
  return Object.freeze({
    Accept: value.Accept,
    "User-Agent": value["User-Agent"],
    Connection: value.Connection,
    Host: hostname,
  });
}

async function collectVerifiedImage(
  response: RemoteImageTransportResponse,
  deadlineAt: number,
  signal: AbortSignal,
  budget: RemoteImageFetchBudget,
): Promise<RemoteImageFetchResult> {
  const contentEncoding = singleHeader(response.headers["content-encoding"]);
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw permanent("remote_image_encoding_blocked");
  }
  const declaredMimeType = parseRemoteImageMimeType(
    singleHeader(response.headers["content-type"]),
  );
  const declaredBytes = parseContentLength(response.headers["content-length"]);
  if (declaredBytes !== null) {
    if (declaredBytes > MAIL_INLINE_IMAGE_MAX_BYTES) {
      throw permanent("remote_image_too_large");
    }
    if (declaredBytes > budget.maxBytes) {
      throw permanent("remote_image_budget_exceeded");
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const candidate of response.body) {
      if (signal.aborted || Date.now() >= deadlineAt) {
        throw transient("remote_image_fetch_timeout");
      }
      if (!(candidate instanceof Uint8Array)) {
        throw permanent("remote_image_body_invalid");
      }
      if (candidate.byteLength === 0) continue;
      total += candidate.byteLength;
      if (total > MAIL_INLINE_IMAGE_MAX_BYTES) {
        throw permanent("remote_image_too_large");
      }
      if (total > budget.maxBytes) {
        throw permanent("remote_image_budget_exceeded");
      }
      chunks.push(Buffer.from(candidate));
    }
    if (total === 0 || (declaredBytes !== null && declaredBytes !== total)) {
      throw permanent("remote_image_body_invalid");
    }
    let data: Buffer = Buffer.concat(chunks, total);
    let inspected = inspectRemoteRaster(declaredMimeType, data);
    if (
      inspected?.mimeType === "image/gif" &&
      !isSafeRemoteRaster(inspected.raster)
    ) {
      const firstFrame = extractFirstGifFrame(data);
      const firstFrameRaster =
        firstFrame === null ? null : inspectMailRaster("image/gif", firstFrame);
      if (
        firstFrame !== null &&
        firstFrameRaster !== null &&
        isSafeRemoteRaster(firstFrameRaster)
      ) {
        data.fill(0);
        data = firstFrame;
        inspected = Object.freeze({
          mimeType: "image/gif",
          raster: firstFrameRaster,
        });
      } else {
        firstFrame?.fill(0);
      }
    }
    if (inspected === null || !isSafeRemoteRaster(inspected.raster)) {
      data.fill(0);
      throw permanent("remote_image_raster_invalid");
    }
    const { mimeType, raster } = inspected;
    if (raster.width <= 2 && raster.height <= 2) {
      data.fill(0);
      throw permanent("remote_image_tracking_pixel_blocked");
    }
    if (
      raster.frames > budget.maxFrames ||
      BigInt(raster.width) * BigInt(raster.height) * BigInt(raster.frames) >
        BigInt(budget.maxPixels)
    ) {
      data.fill(0);
      throw permanent("remote_image_budget_exceeded");
    }
    return Object.freeze({ mimeType, data, raster });
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
}

function validateFetchBudget(value: RemoteImageFetchBudget): RemoteImageFetchBudget {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.maxBytes) ||
    value.maxBytes < 1 ||
    value.maxBytes > MAIL_RESOURCE_LIMITS.maxRemoteImageBytesPerMessage ||
    !Number.isSafeInteger(value.maxPixels) ||
    value.maxPixels < 1 ||
    value.maxPixels > MAIL_RESOURCE_LIMITS.maxInlineImagePixels ||
    !Number.isSafeInteger(value.maxFrames) ||
    value.maxFrames < 1 ||
    value.maxFrames > MAIL_RESOURCE_LIMITS.maxInlineImageFrames
  ) {
    throw permanent("remote_image_budget_invalid");
  }
  return Object.freeze({
    maxBytes: value.maxBytes,
    maxPixels: value.maxPixels,
    maxFrames: value.maxFrames,
  });
}

function redirectTarget(
  current: URL,
  location: string | readonly string[] | undefined,
): URL {
  if (typeof location !== "string" || location.length === 0 || location.length > 2_048) {
    throw permanent("remote_image_redirect_invalid");
  }
  let next: URL;
  try {
    next = new URL(location, current);
    next.hash = "";
    validateMailRemoteImageSourceUrl(next.toString());
  } catch {
    throw permanent("remote_image_redirect_invalid");
  }
  return next;
}

function parseRemoteImageMimeType(value: string | null): string {
  const mimeType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (
    !REMOTE_IMAGE_MIME_TYPES.has(mimeType) &&
    mimeType !== REMOTE_IMAGE_GENERIC_MIME_TYPE
  ) {
    throw permanent("remote_image_mime_blocked");
  }
  return mimeType;
}

function inspectRemoteRaster(
  declaredMimeType: string,
  data: Uint8Array,
): { readonly mimeType: string; readonly raster: VerifiedMailRaster } | null {
  if (declaredMimeType !== REMOTE_IMAGE_GENERIC_MIME_TYPE) {
    const raster = inspectMailRaster(declaredMimeType, data);
    return raster === null
      ? null
      : Object.freeze({ mimeType: declaredMimeType, raster });
  }
  const matches = [...REMOTE_IMAGE_MIME_TYPES].flatMap((mimeType) => {
    const raster = inspectMailRaster(mimeType, data);
    return raster === null
      ? []
      : [Object.freeze({ mimeType, raster })];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function parseContentLength(value: string | readonly string[] | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !/^\d{1,16}$/.test(value)) {
    throw permanent("remote_image_length_invalid");
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 1) {
    throw permanent("remote_image_length_invalid");
  }
  return bytes;
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw permanent("remote_image_header_invalid");
  }
  return value;
}

function isSafeRemoteRaster(raster: VerifiedMailRaster): boolean {
  if (
    !Number.isSafeInteger(raster.width) ||
    raster.width < 1 ||
    !Number.isSafeInteger(raster.height) ||
    raster.height < 1 ||
    !Number.isSafeInteger(raster.frames) ||
    raster.frames < 1 ||
    raster.frames > MAIL_RESOURCE_LIMITS.maxInlineImageFrames
  ) {
    return false;
  }
  return (
    BigInt(raster.width) * BigInt(raster.height) * BigInt(raster.frames) <=
    BigInt(MAIL_RESOURCE_LIMITS.maxInlineImagePixels)
  );
}

function createNodeLookup() {
  const resolver = new Resolver();
  return {
    resolve4: async (hostname: string) =>
      resolver.resolve4(hostname, { ttl: true }) as Promise<DnsAddressRecord[]>,
    resolve6: async (hostname: string) =>
      resolver.resolve6(hostname, { ttl: true }) as Promise<DnsAddressRecord[]>,
    cancel: () => resolver.cancel(),
  };
}

async function resolveFamily(
  request: Promise<readonly DnsAddressRecord[]>,
  family: 4 | 6,
): Promise<readonly (DnsAddressRecord & { readonly family: 4 | 6 })[]> {
  try {
    return (await request).map((record) => Object.freeze({ ...record, family }));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENODATA"
    ) {
      return [];
    }
    throw error;
  }
}

function canonicalAddress(address: string, family: 4 | 6): string | null {
  if (typeof address !== "string" || address.includes("%") || isIP(address) !== family) {
    return null;
  }
  const parsed = SocketAddress.parse(
    family === 6 ? `[${address}]:443` : `${address}:443`,
  );
  return parsed?.address ?? null;
}

function transient(code: string): RemoteImageFetchError {
  return new RemoteImageFetchError("transient", code);
}

function permanent(code: string): RemoteImageFetchError {
  return new RemoteImageFetchError("permanent", code);
}
