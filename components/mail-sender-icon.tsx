"use client";

import { useState } from "react";
import type { MailAddress } from "@/lib/mail/message-types";

/** Domain for the sender-icon proxy: the first participant's address after
 *  the last "@", lowercased. Returns null when there is nothing icon-worthy;
 *  the server route performs the full syntax and SSRF validation. */
export function senderIconDomain(
  participants: readonly MailAddress[],
): string | null {
  const address = participants[0]?.address ?? "";
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1).toLowerCase();
  return domain.includes(".") ? domain : null;
}

/** The monogram fallback initial. Display names arrive with invisible
 *  prefixes (zero-width spaces, BOMs, control bytes) that `trim()` leaves in
 *  place and `charAt(0)` returns as a blank glyph, so the prefix is stripped
 *  first and the initial is the first code point, never a half surrogate. */
export function senderInitial(value: string | null | undefined): string {
  const cleaned = (value ?? "").replace(/^[\p{Cf}\p{Cc}\p{Zs}]+/u, "");
  const initial = Array.from(cleaned)[0];
  return initial ? initial.toLocaleUpperCase() : "?";
}

/** A served favicon under 2px on either edge is a tracking pixel or a blank
 *  placeholder, never a logo — the monogram reads better. */
const MIN_ICON_EDGE = 2;

type MailSenderIconProps = {
  readonly participants: readonly MailAddress[];
  /** Avatar edge in px. Default 32 matches the reader avatar (`size-8`). */
  readonly size?: number;
};

/** Sender avatar: the domain favicon via the same-origin proxy, monogram on
 *  any failure. No third-party URL ever enters the DOM — the only `src` is
 *  the /api/mail/sender-icon proxy path. */
export function MailSenderIcon({ participants, size = 32 }: MailSenderIconProps) {
  const domain = senderIconDomain(participants);
  const [failedDomain, setFailedDomain] = useState<string | null>(null);
  const failed = domain !== null && failedDomain === domain;

  if (!domain || failed) {
    const label = participants[0]?.name || participants[0]?.address;
    return (
      <span
        aria-hidden="true"
        className="grid shrink-0 place-items-center rounded-full bg-fill-active font-semibold text-ink-2"
        // The initial is sized to the circle, not fixed: 12 at the 32 avatar,
        // the same fraction under it, so a stacked 18 does not carry a glyph
        // drawn for a mark half again its size.
        style={{ width: size, height: size, fontSize: Math.round(size * 0.375) }}
      >
        {senderInitial(label)}
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- same-origin proxy bytes; next/image adds nothing here
    <img
      src={`/api/mail/sender-icon/${encodeURIComponent(domain)}`}
      alt=""
      loading="lazy"
      referrerPolicy="no-referrer"
      className="shrink-0 rounded-full bg-fill-active object-cover"
      style={{ width: size, height: size }}
      onError={() => setFailedDomain(domain)}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (image.naturalWidth < MIN_ICON_EDGE || image.naturalHeight < MIN_ICON_EDGE) {
          setFailedDomain(domain);
        }
      }}
    />
  );
}
