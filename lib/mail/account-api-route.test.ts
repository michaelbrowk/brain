import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readBoundedMailJson,
  runMailThreadApiAction,
} from "./account-api-route";

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
        stripped: ["starred", "listMessage", "sizeBytes", "category"],
      },
      {
        header: "2",
        kept: ["starred"],
        stripped: ["listMessage", "sizeBytes", "category"],
      },
      {
        header: "3",
        kept: ["starred", "listMessage", "sizeBytes"],
        stripped: ["category"],
      },
      {
        header: "4",
        kept: ["starred", "listMessage", "sizeBytes", "category"],
        stripped: [],
      },
      {
        header: "999",
        kept: [],
        stripped: ["starred", "listMessage", "sizeBytes", "category"],
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
