import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readBoundedMailJson,
  runMailThreadApiAction,
} from "./account-api-route";
import { MAIL_SERVICE_HTTP_LIMITS } from "./service/limits";

afterEach(() => {
  vi.useRealTimers();
});

describe("readBoundedMailJson", () => {
  it("cancels a body that does not finish before the read deadline", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const result = readBoundedMailJson(
      streamedRequest(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    const rejected = expect(result).rejects.toMatchObject({ status: 400 });

    await vi.runAllTimersAsync();

    await rejected;
    expect(cancelled).toBe(true);
  });

  it("cancels body reading when the request is aborted", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const result = readBoundedMailJson(
      streamedRequest(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        controller.signal,
      ),
    );

    controller.abort();

    await expect(result).rejects.toMatchObject({ status: 400 });
    expect(cancelled).toBe(true);
  });

  it("rejects an unbounded sequence of empty chunks", async () => {
    let cancelled = false;
    const result = readBoundedMailJson(
      streamedRequest(
        new ReadableStream<Uint8Array>({
          start(stream) {
            for (let index = 0; index < 33; index += 1) {
              stream.enqueue(new Uint8Array(0));
            }
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );

    await expect(result).rejects.toMatchObject({ status: 400 });
    expect(cancelled).toBe(true);
  });

  const jsonRequest = (body: string) =>
    new Request("https://brain.test/api/mail/drafts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  /** More structure than a send holds, in less than the small cap. */
  const manyDecisions = `[${"[],".repeat(2_000)}[]]`;

  it("holds a body read past the small cap to the structure of a send", async () => {
    const parse = vi.spyOn(JSON, "parse");
    try {
      await expect(
        readBoundedMailJson(
          jsonRequest(manyDecisions),
          MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
    await expect(
      readBoundedMailJson(
        jsonRequest('{"to":["a@example.net","b@example.net"],"attachments":[]}'),
        MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes,
      ),
    ).resolves.toEqual({ to: ["a@example.net", "b@example.net"], attachments: [] });
  });

  it("leaves a body under the small cap to its own route's shape", async () => {
    // Sixteen kibibytes cost nothing to parse, and a route that reads them
    // may take a longer list than a send does.
    await expect(readBoundedMailJson(jsonRequest(manyDecisions))).resolves.toHaveLength(
      2_001,
    );
  });
});

describe("runMailThreadApiAction", () => {
  const page = () => ({
    apiVersion: 1,
    items: [
      {
        accountId: "account-a11111111111111111111111111111111",
        threadId: "thread_1",
        subject: "Hello",
        participants: [],
        snippet: null,
        lastMessageAt: 1,
        messageCount: 1,
        unread: true,
        starred: true,
        hasAttachments: false,
        listMessage: true,
        sizeBytes: 4_096,
        category: "newsletter",
        newSender: false,
      },
    ],
    nextCursor: null,
    sync: { status: "idle", lastSuccessfulAt: 1 },
  });
  const threadRequest = (header?: string) =>
    new Request("https://brain.test/api/mail/threads", {
      headers:
        header === undefined ? {} : { "x-brain-mail-thread-state": header },
    });

  it("projects thread-state fields by the requested contract tier", async () => {
    const cases: Array<{
      readonly header: string | undefined;
      readonly kept: readonly string[];
      readonly stripped: readonly string[];
    }> = [
      {
        header: undefined,
        kept: [],
        stripped: ["starred", "listMessage", "sizeBytes", "category", "newSender"],
      },
      {
        header: "2",
        kept: ["starred"],
        stripped: ["listMessage", "sizeBytes", "category", "newSender"],
      },
      {
        header: "3",
        kept: ["starred", "listMessage", "sizeBytes"],
        stripped: ["category", "newSender"],
      },
      {
        header: "4",
        kept: ["starred", "listMessage", "sizeBytes", "category"],
        stripped: ["newSender"],
      },
      {
        header: "5",
        kept: ["starred", "listMessage", "sizeBytes", "category", "newSender"],
        stripped: [],
      },
      // A later client's tier reads as the highest one this build knows.
      {
        header: "999",
        kept: ["starred", "listMessage", "sizeBytes", "category", "newSender"],
        stripped: [],
      },
      {
        header: "latest",
        kept: [],
        stripped: ["starred", "listMessage", "sizeBytes", "category", "newSender"],
      },
    ];
    for (const testCase of cases) {
      const response = await runMailThreadApiAction(
        threadRequest(testCase.header),
        async () => page(),
      );
      expect(response.status).toBe(200);
      const item = ((await response.json()) as {
        items: Record<string, unknown>[];
      }).items[0]!;
      for (const field of testCase.kept) {
        expect(item).toHaveProperty(field);
      }
      for (const field of testCase.stripped) {
        expect(item).not.toHaveProperty(field);
      }
    }
  });
});

function streamedRequest(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Request {
  return new Request("https://brain.test/api/mail/drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
    signal,
  } as RequestInit & { duplex: "half" });
}
