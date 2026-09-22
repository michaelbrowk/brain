import { describe, expect, it } from "vitest";
import {
  BRIDGE_VERSION,
  appAnswer,
  appEvent,
  appRefusal,
  appRequestSchema,
} from "./bridge";
import { APP_ENTRY_MAX_BYTES } from "./model";

const envelope = { v: 1, rid: "r1" } as const;

describe("the bridge protocol", () => {
  it("accepts every request the spec lists", () => {
    const requests = [
      { ...envelope, type: "hello" },
      { ...envelope, type: "read.tree" },
      { ...envelope, type: "read.page", id: "page1" },
      { ...envelope, type: "read.pages", query: "hola" },
      { ...envelope, type: "write.page", id: "page1", markdown: "x", rev: "abc" },
      { ...envelope, type: "create.page", title: "Words", markdown: "x" },
      { ...envelope, type: "state.get" },
      { ...envelope, type: "state.set", json: { seen: 1 } },
      { ...envelope, type: "open", id: "page1" },
      { ...envelope, type: "toast", text: "Saved" },
    ];
    for (const request of requests) {
      expect(appRequestSchema.safeParse(request).success).toBe(true);
    }
  });

  it("refuses a message from another version or with no request id", () => {
    expect(appRequestSchema.safeParse({ v: 2, rid: "r1", type: "hello" }).success).toBe(false);
    expect(appRequestSchema.safeParse({ v: 1, type: "hello" }).success).toBe(false);
  });

  it("refuses a request whose type it does not know", () => {
    expect(appRequestSchema.safeParse({ ...envelope, type: "delete.page", id: "p" }).success).toBe(false);
  });

  it("refuses a payload of the wrong shape", () => {
    expect(appRequestSchema.safeParse({ ...envelope, type: "read.page" }).success).toBe(false);
    expect(
      appRequestSchema.safeParse({ ...envelope, type: "write.page", id: "p", markdown: "x" }).success,
    ).toBe(false);
    expect(appRequestSchema.safeParse({ ...envelope, type: "toast", text: "x".repeat(400) }).success).toBe(false);
  });

  it("bounds the markdown of a create the way a page write is bounded", () => {
    // Without the max the host relays a create of any size at all, and an app
    // may mint sixty-four pages that way. The route refuses it too; this is
    // the half that refuses before anything crosses the network.
    expect(
      appRequestSchema.safeParse({
        ...envelope,
        type: "create.page",
        title: "Words",
        markdown: "x".repeat(APP_ENTRY_MAX_BYTES + 1),
      }).success,
    ).toBe(false);
    expect(
      appRequestSchema.safeParse({
        ...envelope,
        type: "create.page",
        title: "Words",
        markdown: "x".repeat(APP_ENTRY_MAX_BYTES),
      }).success,
    ).toBe(true);
  });

  it("needs state.set to carry a payload, and takes any JSON under it", () => {
    // z.unknown() is optional in zod 3: without the presence check a bare
    // state.set parses and writes undefined over the app's memory.
    expect(appRequestSchema.safeParse({ ...envelope, type: "state.set" }).success).toBe(false);
    for (const json of [null, 0, "", false, [], {}]) {
      expect(appRequestSchema.safeParse({ ...envelope, type: "state.set", json }).success).toBe(true);
    }
  });

  it("bounds a toast to one line", () => {
    const parsed = appRequestSchema.parse({ ...envelope, type: "toast", text: " two\nlines " });
    expect(parsed.type === "toast" && parsed.text).toBe("two lines");
  });

  it("answers and refuses in one shape each, carrying the request id", () => {
    expect(appAnswer("r1", { rev: "abc" })).toEqual({
      v: BRIDGE_VERSION,
      rid: "r1",
      ok: true,
      data: { rev: "abc" },
    });
    expect(appRefusal("r1", "that page is not this app's to write", "not_owned")).toEqual({
      v: BRIDGE_VERSION,
      rid: "r1",
      ok: false,
      error: "that page is not this app's to write",
      reason: "not_owned",
    });
  });

  it("carries no em-dash in a sentence the app may show", () => {
    const refusal = appRefusal("r1", "that page is not this app's to write", "not_owned");
    expect(JSON.stringify(refusal)).not.toContain("—");
  });

  it("sends an event with no request id, because nothing asked for it", () => {
    expect(appEvent("theme", "dark")).toEqual({ v: BRIDGE_VERSION, event: "theme", theme: "dark" });
    expect(appEvent("visibility", false)).toEqual({
      v: BRIDGE_VERSION,
      event: "visibility",
      visible: false,
    });
  });
});
