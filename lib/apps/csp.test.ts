import { describe, expect, it } from "vitest";
import { APP_FRAME_SANDBOX, appFrameCsp } from "./csp";

const ORIGIN = "https://brain.example";

describe("the app frame's policy", () => {
  it("is the exact string, for one origin and one app", () => {
    // The host-source stops at `/t/`, one segment short of the token: the
    // token varies per grant and a policy cannot be re-cut per mint. It still
    // names one app, which is what it is for.
    expect(appFrameCsp(ORIGIN, "app1")).toBe(
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src blob: data: https://brain.example/api/app/app1/t/; " +
        "font-src data: https://brain.example/api/app/app1/t/; " +
        "media-src data: https://brain.example/api/app/app1/t/; " +
        "connect-src 'none'; frame-ancestors https://brain.example; " +
        "base-uri 'none'; form-action 'none'",
    );
  });

  it("names an explicit host-source, never the keyword that matches nothing", () => {
    // 'self' inside an opaque-origin sandbox matches no origin at all, so an
    // asset under it never paints and says nothing about why.
    const policy = appFrameCsp(ORIGIN, "app1");
    for (const directive of ["img-src", "font-src", "media-src", "frame-ancestors"]) {
      const value = policy.split("; ").find((part) => part.startsWith(`${directive} `))!;
      expect(value).not.toContain("'self'");
      expect(value).toContain(ORIGIN);
    }
  });

  it("scopes one app's frame to one app's files", () => {
    expect(appFrameCsp(ORIGIN, "app1")).not.toContain("/api/app/app2/");
    expect(appFrameCsp(ORIGIN, "app2")).toContain("/api/app/app2/t/");
  });

  it("lets the frame reach nothing on the network", () => {
    expect(appFrameCsp(ORIGIN, "app1")).toContain("connect-src 'none'");
  });

  it("builds for an IPv6-literal origin, which a private install can have", () => {
    // `oauthIssuer()` accepts `http://[fd12:3456::1]:3020` as the owner's own
    // network, so an install can genuinely be on one. The pattern here read
    // `[A-Za-z0-9.-]+`, which matches no bracket and no colon, so every app
    // page on such an install threw "app frame CSP needs an exact origin"
    // instead of drawing.
    for (const origin of [
      "http://[fd12:3456::1]:3020",
      "http://[fe80::1]",
      "https://[2001:db8::1]:8443",
    ]) {
      const policy = appFrameCsp(origin, "app1");
      expect(policy).toContain(`${origin}/api/app/app1/t/`);
      expect(policy).toContain("connect-src 'none'");
    }
  });

  it("refuses an origin or an id that is not one", () => {
    // Both reach a header, so neither may carry a newline, a semicolon or a
    // space: a header split is how a policy becomes two policies.
    for (const bad of [
      "https://a\nb",
      "https://a b",
      "https://a;b",
      "not-an-origin",
      "https://a/path",
      // An IPv6 origin is accepted now, so the shapes that are not one have to
      // be asked for by name: an unclosed bracket, a bracket around something
      // that is not hex, and a bracketed host carrying a separator.
      "http://[fd12:3456::1",
      "http://[not:hex::zz]",
      "http://[fd12::1];x",
      "http://[fd12::1]/path",
    ]) {
      expect(() => appFrameCsp(bad, "app1")).toThrow();
    }
    for (const bad of ["a b", "a;b", "a/b", "../x", ""]) {
      expect(() => appFrameCsp(ORIGIN, bad)).toThrow();
    }
  });

  it("is the three sandbox tokens and nothing else", () => {
    expect(APP_FRAME_SANDBOX).toBe("allow-scripts allow-forms allow-modals");
    expect(APP_FRAME_SANDBOX).not.toContain("allow-same-origin");
    expect(APP_FRAME_SANDBOX).not.toContain("allow-top-navigation");
    expect(APP_FRAME_SANDBOX).not.toContain("allow-popups");
  });
});
