import { describe, expect, it } from "vitest";

import { declaresJson } from "./json-body";

const headers = (type?: string) =>
  new Headers(type === undefined ? {} : { "content-type": type });

describe("declaresJson", () => {
  it("accepts the declaration with any parameters or casing", () => {
    for (const type of [
      "application/json",
      "application/json;charset=UTF-8",
      "application/json; charset=utf-8",
      " APPLICATION/JSON ",
    ]) {
      expect(declaresJson(headers(type)), type).toBe(true);
    }
  });

  it("refuses every type a cross-site form can declare, and a missing one", () => {
    for (const type of [
      undefined,
      "",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json-patch+json",
      "application/jsonx",
    ]) {
      expect(declaresJson(headers(type)), String(type)).toBe(false);
    }
  });
});
