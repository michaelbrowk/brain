import { describe, expect, it } from "vitest";
import { safeOAuthReturnTo } from "./return-to";

describe("OAuth login return target", () => {
  it("keeps only the exact relative consent route and its query", () => {
    expect(
      safeOAuthReturnTo(
        "/oauth/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
      ),
    ).toBe(
      "/oauth/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
    );
  });

  it.each([
    "//evil.example/oauth/authorize",
    "https://evil.example/oauth/authorize",
    "/\\evil.example/oauth/authorize",
    "/oauth/authorize\\@evil.example",
    "/oauth/authorize%5c@evil.example",
    "/oauth/authorize%0a@evil.example",
    "/oauth/authorize#https://evil.example",
    "/oauth/authorize/../private",
    "/oauth/authorize.evil",
    "/api/tree",
    "https://user:password@brain-return.invalid/oauth/authorize",
  ])("rejects an unsafe target: %s", (target) => {
    expect(safeOAuthReturnTo(target)).toBe("/");
  });
});
