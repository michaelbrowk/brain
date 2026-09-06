// @vitest-environment jsdom

// The copy button is the only way most people will ever move a wallet
// address, so what it puts on the clipboard is checked character for
// character against what the row displays. A button that copies a shortened
// string, or a row that displays a shortened one, costs whoever trusts it
// their money — that is the failure mode this file exists for.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DonateSection } from "./donate-section";

const ADDRESSES = {
  "USDT (TRC20)": "TPWv2npwnpnZE4UsnRLFDDP6biqoeDBDqp",
  "USDT (ERC20)": "0xBd795A33e95331118dFB91D922545ead648d2a3F",
  "Ethereum (ETH)": "0xBd795A33e95331118dFB91D922545ead648d2a3F",
  Bitcoin: "bc1qcd2qwp2jltgmc368sezn36su334j368tf8d7hk",
} as const;

describe("DonateSection", () => {
  let host: HTMLDivElement;
  let root: Root;
  let written: string[];
  let toasts: string[];

  beforeEach(async () => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    written = [];
    toasts = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (text: string) => {
          written.push(text);
          return Promise.resolve();
        },
      },
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () =>
      root.render(<DonateSection onToast={(title) => toasts.push(title)} />),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  const copyButton = (label: string) =>
    host.querySelector<HTMLButtonElement>(
      `[aria-label="Copy the ${label} address"]`,
    );

  const valueSpan = (label: string) =>
    copyButton(label)?.parentElement?.querySelector<HTMLElement>("span");

  it("copies the whole address, byte for byte", async () => {
    for (const [label, address] of Object.entries(ADDRESSES)) {
      written.length = 0;
      const button = copyButton(label);
      expect(button, `no copy button for ${label}`).not.toBeNull();
      await act(async () => button!.click());
      expect(written).toEqual([address]);
      // and the string itself, not a normalised one: the Ethereum address's
      // mixed case IS its EIP-55 checksum
      expect(written[0]).toBe(address);
      expect(toasts.at(-1)).toBe(`${label} address copied`);
    }
  });

  it("shows every address whole rather than truncating it", () => {
    for (const [label, address] of Object.entries(ADDRESSES)) {
      const span = valueSpan(label);
      expect(span?.textContent, `no value shown for ${label}`).toBe(address);
      // `truncate` would clip the tail behind an ellipsis at any width the
      // string does not fit; the address wraps instead
      expect(span?.className).not.toContain("truncate");
      expect(span?.className).toContain("break-all");
    }
  });

  it("sends ETH and ERC20 USDT to one address, and says so", () => {
    expect(written).toEqual([]);
    expect(ADDRESSES["USDT (ERC20)"]).toBe(ADDRESSES["Ethereum (ETH)"]);
    // the repeat is only safe if the section explains it — otherwise it
    // reads as a copy-paste slip and nobody sends anything
    expect(host.textContent).toContain("The same address as ETH below");
    expect(host.textContent).toContain(
      "One Ethereum account receives both ETH and ERC20 USDT",
    );
  });

  it("says why the section is here, in the owner's words", () => {
    expect(host.textContent).toContain(
      "I wrote Brain and I run it myself. Donations go into the work on it, the fixes and the features that come next.",
    );
  });

  it("links GitHub Sponsors out of the app safely", () => {
    const link = host.querySelector<HTMLAnchorElement>(
      'a[href="https://github.com/sponsors/michaelbrowk"]',
    );
    expect(link).not.toBeNull();
    expect(link?.target).toBe("_blank");
    expect(link?.rel).toBe("noopener noreferrer");
  });

  it("reports a clipboard that refuses instead of claiming a copy", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    await act(async () => copyButton("Bitcoin")!.click());
    expect(toasts.at(-1)).toBe("Couldn't copy. Try again.");
  });
});
