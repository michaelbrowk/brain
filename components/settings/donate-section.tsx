"use client";

// Donate: who wrote Brain, where the money goes, and the ways to send it.
// The section changes nothing about this instance, which is why it sits last
// in the order, past Account.

import { SettingsGroup, SettingsRow, CopyRow } from "./shared";

/** The wallets in the order they are offered. Ethereum and ERC20 USDT are
 *  one address on purpose: a single Ethereum account receives both, and each
 *  hint says so, or the repeat reads as a copy-paste slip.
 *
 *  Every address is a checksummed string — EIP-55 mixed case on the Ethereum
 *  one, base58check on the Tron one, bech32 on the Bitcoin one. Changing a
 *  character, the letter case included, sends money to a stranger. */
const WALLETS: {
  label: string;
  hint: string;
  address: string;
}[] = [
  {
    label: "USDT (TRC20)",
    hint: "Tron network",
    address: "TPWv2npwnpnZE4UsnRLFDDP6biqoeDBDqp",
  },
  {
    label: "USDT (ERC20)",
    hint: "Ethereum network. The same address as ETH below",
    address: "0xBd795A33e95331118dFB91D922545ead648d2a3F",
  },
  {
    label: "Ethereum (ETH)",
    hint: "One Ethereum account receives both ETH and ERC20 USDT",
    address: "0xBd795A33e95331118dFB91D922545ead648d2a3F",
  },
  {
    label: "Bitcoin",
    hint: "Bitcoin network",
    address: "bc1qcd2qwp2jltgmc368sezn36su334j368tf8d7hk",
  },
];

export function DonateSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const copy = async (address: string, label: string) => {
    try {
      await navigator.clipboard.writeText(address);
      onToast(`${label} address copied`);
    } catch {
      onToast("Couldn't copy. Try again.");
    }
  };

  return (
    <div className="space-y-7">
      <div>
        <h3 className="text-h3 text-ink">Where donations go</h3>
        {/* the measure the Connections note uses: at the group's full width
            this paragraph ran past the readable ceiling */}
        <p className="mt-0.5 max-w-[56ch] text-caption leading-relaxed text-ink-3">
          I wrote Brain and I run it myself. Donations go into the work on it,
          the fixes and the features that come next.
        </p>
      </div>
      <SettingsGroup>
        <SettingsRow
          label="GitHub Sponsors"
          hint="Monthly or one time, through your GitHub account"
        >
          <a
            href="https://github.com/sponsors/michaelbrowk"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-glass tint-hover brain-touch-min"
          >
            Sponsor
          </a>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Crypto" description="Every address is shown in full">
        {WALLETS.map((wallet) => (
          <SettingsRow
            key={wallet.label}
            label={wallet.label}
            hint={wallet.hint}
            stack
          >
            <CopyRow
              label={`Copy the ${wallet.label} address`}
              value={wallet.address}
              wrap
              onCopy={() => void copy(wallet.address, wallet.label)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  );
}
