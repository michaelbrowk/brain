import {
  GMAIL_API_LIMITS,
  GmailApiError,
} from "./api-types";

const OBJECT_START = 0x7b;
const OBJECT_END = 0x7d;
const QUOTE = 0x22;
const COLON = 0x3a;
const COMMA = 0x2c;
const PADDING = 0x3d;
const BASE64_DECODE_CHARACTERS = 64 * 1024;
const RAW_FIELDS = new Set(["id", "sizeEstimate", "raw"]);
const SAFE_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;

export interface GmailRawResponseMetadata {
  readonly id: string;
  readonly sizeEstimate: number;
}

export interface GmailRawResponseDecoder {
  readonly chunks: AsyncIterable<Uint8Array>;
  finish(): GmailRawResponseMetadata;
}

export async function openGmailRawResponse(
  response: Response,
  requestedId: string,
  signal: AbortSignal,
): Promise<GmailRawResponseDecoder> {
  const body = response.body;
  if (body === null) {
    throw invalidResponse();
  }
  let declaredBytes: number | null;
  try {
    declaredBytes = parseContentLength(response.headers.get("Content-Length"));
  } catch (error) {
    await body.cancel().catch(() => undefined);
    throw error;
  }
  if (
    declaredBytes !== null &&
    declaredBytes > GMAIL_API_LIMITS.rawResponseBytes
  ) {
    await body.cancel().catch(() => undefined);
    throw invalidResponse();
  }

  let result: GmailRawResponseMetadata | null = null;
  const chunks = decodeRawEnvelope(
    body,
    declaredBytes,
    requestedId,
    signal,
    (metadata) => {
      result = metadata;
    },
  );
  return Object.freeze({
    chunks,
    finish(): GmailRawResponseMetadata {
      if (result === null) throw invalidResponse();
      return result;
    },
  });
}

async function* decodeRawEnvelope(
  body: ReadableStream<Uint8Array>,
  declaredBytes: number | null,
  requestedId: string,
  signal: AbortSignal,
  complete: (metadata: GmailRawResponseMetadata) => void,
): AsyncIterable<Uint8Array> {
  const input = new BoundedResponseReader(
    body,
    declaredBytes,
    GMAIL_API_LIMITS.rawResponseBytes,
    signal,
  );
  const seen = new Set<string>();
  let id: string | null = null;
  let sizeEstimate: number | null = null;
  let decodedBytes = 0;
  try {
    if ((await readNonWhitespace(input)) !== OBJECT_START) throw invalidResponse();
    let token = await readNonWhitespace(input);
    if (token === OBJECT_END || token === null) throw invalidResponse();

    for (;;) {
      if (token !== QUOTE) throw invalidResponse();
      const field = await readAsciiString(input, 32);
      if (!RAW_FIELDS.has(field) || seen.has(field)) throw invalidResponse();
      seen.add(field);
      if ((await readNonWhitespace(input)) !== COLON) throw invalidResponse();
      const valueStart = await readNonWhitespace(input);

      if (field === "id") {
        if (valueStart !== QUOTE) throw invalidResponse();
        const candidate = await readAsciiString(input, 255);
        if (!SAFE_RESOURCE_ID.test(candidate)) throw invalidResponse();
        id = candidate;
      } else if (field === "sizeEstimate") {
        if (valueStart === null || !isDigit(valueStart)) throw invalidResponse();
        sizeEstimate = await readUnsignedInteger(input, valueStart);
        if (sizeEstimate > GMAIL_API_LIMITS.rawMessageBytes) {
          throw invalidResponse();
        }
      } else {
        if (valueStart !== QUOTE) throw invalidResponse();
        for await (const chunk of readBase64UrlString(input)) {
          if (chunk.byteLength > GMAIL_API_LIMITS.rawMessageBytes - decodedBytes) {
            throw invalidResponse();
          }
          decodedBytes += chunk.byteLength;
          yield chunk;
        }
      }

      token = await readNonWhitespace(input);
      if (token === OBJECT_END) break;
      if (token !== COMMA) throw invalidResponse();
      token = await readNonWhitespace(input);
      if (token === OBJECT_END || token === null) throw invalidResponse();
    }

    if (
      seen.size !== RAW_FIELDS.size ||
      id === null ||
      id !== requestedId ||
      sizeEstimate === null ||
      decodedBytes < 1 ||
      (await readNonWhitespace(input)) !== null
    ) {
      throw invalidResponse();
    }
    signal.throwIfAborted();
    complete(Object.freeze({ id, sizeEstimate }));
  } finally {
    await input.close();
  }
}

async function* readBase64UrlString(
  input: BoundedResponseReader,
): AsyncIterable<Uint8Array> {
  let encoded = "";
  let encodedCharacters = 0;
  let padding = 0;
  let ended = false;
  for (;;) {
    const available = await input.available();
    if (available === null) throw invalidResponse();
    if (padding > 0) {
      const byte = available[0]!;
      if (byte === QUOTE) {
        input.consume(1);
        ended = true;
        break;
      }
      if (byte !== PADDING) throw invalidResponse();
      input.consume(1);
      encodedCharacters += 1;
      padding += 1;
      if (
        padding > 2 ||
        encodedCharacters > GMAIL_API_LIMITS.rawBase64UrlCharacters
      ) {
        throw invalidResponse();
      }
      continue;
    }

    let runLength = 0;
    while (
      runLength < available.byteLength &&
      isBase64Url(available[runLength]!)
    ) {
      runLength += 1;
    }
    if (runLength > 0) {
      encodedCharacters += runLength;
      if (encodedCharacters > GMAIL_API_LIMITS.rawBase64UrlCharacters) {
        throw invalidResponse();
      }
      encoded += Buffer.from(
        available.buffer,
        available.byteOffset,
        runLength,
      ).toString("ascii");
      input.consume(runLength);
      while (encoded.length >= BASE64_DECODE_CHARACTERS) {
        const decoded = decodeCanonicalBase64Url(
          encoded.slice(0, BASE64_DECODE_CHARACTERS),
        );
        encoded = encoded.slice(BASE64_DECODE_CHARACTERS);
        try {
          yield decoded;
        } finally {
          decoded.fill(0);
        }
      }
      continue;
    }

    const byte = available[0]!;
    if (byte === QUOTE) {
      input.consume(1);
      ended = true;
      break;
    }
    if (byte !== PADDING) throw invalidResponse();
    input.consume(1);
    encodedCharacters += 1;
    padding = 1;
    if (encodedCharacters > GMAIL_API_LIMITS.rawBase64UrlCharacters) {
      throw invalidResponse();
    }
    const tailLength = encoded.length % 4;
    if (tailLength !== 2 && tailLength !== 3) throw invalidResponse();
    const prefixLength = encoded.length - tailLength;
    if (prefixLength > 0) {
      const prefix = decodeCanonicalBase64Url(encoded.slice(0, prefixLength));
      try {
        yield prefix;
      } finally {
        prefix.fill(0);
      }
      encoded = encoded.slice(prefixLength);
    }
  }

  if (!ended) throw invalidResponse();

  if (padding > 0) {
    if (
      !(
        (encoded.length === 2 && padding === 2) ||
        (encoded.length === 3 && padding === 1)
      )
    ) {
      throw invalidResponse();
    }
  } else {
    const tailLength = encoded.length % 4;
    if (tailLength === 1) throw invalidResponse();
    const prefixLength = encoded.length - tailLength;
    if (prefixLength > 0) {
      const prefix = decodeCanonicalBase64Url(encoded.slice(0, prefixLength));
      try {
        yield prefix;
      } finally {
        prefix.fill(0);
      }
      encoded = encoded.slice(prefixLength);
    }
  }

  if (encoded.length > 0) {
    const decoded = decodeCanonicalBase64Url(encoded);
    try {
      yield decoded;
    } finally {
      decoded.fill(0);
    }
  }
}

class BoundedResponseReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array | null = null;
  private offset = 0;
  private streamedBytes = 0;
  private unreadByte: number | null = null;
  private ended = false;
  private closed = false;

  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly declaredBytes: number | null,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal,
  ) {
    this.reader = body.getReader();
  }

  async read(): Promise<number | null> {
    if (this.unreadByte !== null) {
      const value = this.unreadByte;
      this.unreadByte = null;
      return value;
    }
    const available = await this.available();
    if (available === null) return null;
    const value = available[0] ?? null;
    this.consume(1);
    return value;
  }

  async available(): Promise<Uint8Array | null> {
    if (this.unreadByte !== null) throw invalidResponse();
    for (;;) {
      this.signal.throwIfAborted();
      if (this.chunk !== null && this.offset < this.chunk.byteLength) {
        return this.chunk.subarray(this.offset);
      }
      this.chunk?.fill(0);
      this.chunk = null;
      this.offset = 0;
      const next = await this.reader.read();
      this.signal.throwIfAborted();
      if (next.done) {
        this.ended = true;
        if (
          this.declaredBytes !== null &&
          this.streamedBytes !== this.declaredBytes
        ) {
          throw invalidResponse();
        }
        return null;
      }
      if (!(next.value instanceof Uint8Array)) throw invalidResponse();
      if (
        next.value.byteLength > this.maxBytes - this.streamedBytes ||
        (this.declaredBytes !== null &&
          next.value.byteLength > this.declaredBytes - this.streamedBytes)
      ) {
        next.value.fill(0);
        await this.reader.cancel().catch(() => undefined);
        throw invalidResponse();
      }
      this.streamedBytes += next.value.byteLength;
      this.chunk = next.value;
    }
  }

  consume(bytes: number): void {
    if (
      this.chunk === null ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > this.chunk.byteLength - this.offset
    ) {
      throw invalidResponse();
    }
    this.offset += bytes;
  }

  unread(value: number): void {
    if (this.unreadByte !== null) throw invalidResponse();
    this.unreadByte = value;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.chunk?.fill(0);
    this.chunk = null;
    if (!this.ended) {
      await this.reader.cancel().catch(() => undefined);
    }
    this.reader.releaseLock();
  }
}

async function readNonWhitespace(
  input: BoundedResponseReader,
): Promise<number | null> {
  for (;;) {
    const value = await input.read();
    if (value === null || !isWhitespace(value)) return value;
  }
}

async function readAsciiString(
  input: BoundedResponseReader,
  maxCharacters: number,
): Promise<string> {
  const characters: number[] = [];
  for (;;) {
    const value = await input.read();
    if (value === null) throw invalidResponse();
    if (value === QUOTE) return String.fromCharCode(...characters);
    if (value < 0x20 || value > 0x7e || value === 0x5c) {
      throw invalidResponse();
    }
    characters.push(value);
    if (characters.length > maxCharacters) throw invalidResponse();
  }
}

async function readUnsignedInteger(
  input: BoundedResponseReader,
  first: number,
): Promise<number> {
  let digits = String.fromCharCode(first);
  for (;;) {
    const value = await input.read();
    if (value === null) break;
    if (!isDigit(value)) {
      input.unread(value);
      break;
    }
    digits += String.fromCharCode(value);
    if (digits.length > 10) throw invalidResponse();
  }
  if (digits.length > 1 && digits.startsWith("0")) throw invalidResponse();
  const result = Number(digits);
  if (!Number.isSafeInteger(result)) throw invalidResponse();
  return result;
}

function decodeCanonicalBase64Url(value: string): Buffer {
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    decoded.fill(0);
    throw invalidResponse();
  }
  return decoded;
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw invalidResponse();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw invalidResponse();
  return result;
}

function isWhitespace(value: number): boolean {
  return value === 0x20 || value === 0x09 || value === 0x0a || value === 0x0d;
}

function isDigit(value: number): boolean {
  return value >= 0x30 && value <= 0x39;
}

function isBase64Url(value: number): boolean {
  return (
    (value >= 0x41 && value <= 0x5a) ||
    (value >= 0x61 && value <= 0x7a) ||
    (value >= 0x30 && value <= 0x39) ||
    value === 0x2d ||
    value === 0x5f
  );
}

function invalidResponse(): GmailApiError {
  return new GmailApiError("gmail_response_invalid");
}
