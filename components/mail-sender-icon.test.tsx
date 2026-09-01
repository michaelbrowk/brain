// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MailSenderIcon,
  senderIconDomain,
  senderInitial,
} from "./mail-sender-icon";

describe("senderIconDomain", () => {
  it("takes the lowercased part after the last @ and requires a dot", () => {
    expect(senderIconDomain([{ name: null, address: "ben@Example.COM" }])).toBe(
      "example.com",
    );
    expect(
      senderIconDomain([{ name: null, address: '"weird@local"@sub.example.com' }]),
    ).toBe("sub.example.com");
    expect(senderIconDomain([{ name: null, address: "ben@intranet" }])).toBeNull();
    expect(senderIconDomain([{ name: null, address: "not-an-address" }])).toBeNull();
    expect(senderIconDomain([])).toBeNull();
  });
});

describe("senderInitial", () => {
  it("skips invisible prefixes and takes the first whole code point", () => {
    expect(senderInitial("ben")).toBe("B");
    expect(senderInitial("  ben")).toBe("B");
    expect(senderInitial("\u200bProperty Finder")).toBe("P");
    expect(senderInitial("\ufeff\u00a0\tProperty Finder")).toBe("P");
    expect(senderInitial("\u{1F4E7} Mailer")).toBe("\u{1F4E7}");
    expect(senderInitial("ärzte")).toBe("Ä");
  });

  it("falls back to ? when nothing printable is left", () => {
    expect(senderInitial(null)).toBe("?");
    expect(senderInitial(undefined)).toBe("?");
    expect(senderInitial("")).toBe("?");
    expect(senderInitial("\u200b\u200b")).toBe("?");
  });
});

describe("MailSenderIcon", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("renders a lazy same-origin proxy image and never a third-party URL", async () => {
    await act(async () =>
      root.render(
        <MailSenderIcon
          participants={[{ name: "Ben Johnson", address: "ben@example.com" }]}
        />,
      ),
    );

    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("/api/mail/sender-icon/example.com");
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.style.width).toBe("32px");
    expect(img?.style.height).toBe("32px");
  });

  it("swaps to the sender monogram when the proxy image fails", async () => {
    await act(async () =>
      root.render(
        <MailSenderIcon
          participants={[{ name: "Ben Johnson", address: "ben@example.com" }]}
        />,
      ),
    );

    const img = host.querySelector("img");
    expect(img).not.toBeNull();
    await act(async () => {
      img?.dispatchEvent(new Event("error"));
    });

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("B");
  });

  it("treats a loaded tracking pixel as a failure and keeps a real icon", async () => {
    await act(async () =>
      root.render(
        <MailSenderIcon
          participants={[{ name: "Ben Johnson", address: "ben@example.com" }]}
        />,
      ),
    );

    const icon = host.querySelector("img");
    expect(icon).not.toBeNull();
    Object.defineProperty(icon, "naturalWidth", { value: 16, configurable: true });
    Object.defineProperty(icon, "naturalHeight", { value: 16, configurable: true });
    await act(async () => {
      icon?.dispatchEvent(new Event("load"));
    });
    expect(host.querySelector("img")).not.toBeNull();

    Object.defineProperty(icon, "naturalWidth", { value: 1, configurable: true });
    Object.defineProperty(icon, "naturalHeight", { value: 1, configurable: true });
    await act(async () => {
      icon?.dispatchEvent(new Event("load"));
    });
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("B");
  });

  it("renders the monogram directly when no domain can be derived", async () => {
    await act(async () =>
      root.render(
        <MailSenderIcon participants={[{ name: null, address: "postmaster" }]} size={24} />,
      ),
    );

    expect(host.querySelector("img")).toBeNull();
    const monogram = host.querySelector("span");
    expect(monogram?.textContent).toBe("P");
    expect(monogram?.style.width).toBe("24px");
  });

  it("falls back to ? with no participants at all", async () => {
    await act(async () => root.render(<MailSenderIcon participants={[]} />));

    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toBe("?");
  });
});
