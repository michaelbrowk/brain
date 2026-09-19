import { describe, expect, it } from "vitest";

import { BrainMailClientError } from "@/lib/mail/brain-mail-client";
import { mailRefusalFields } from "./mail-tool-kit";

describe("what a mail tool refuses in", () => {
  /** The service names the figures of a size refusal; the agent has to see
   *  them. Told only `mail_send_request_invalid`, an agent cannot tell whether
   *  a smaller file would go through, and the honest answer to that question is
   *  the reason the service carries the line at all. */
  it("passes on the figures a size refusal named", () => {
    const detail =
      "finished message of 15000000 bytes exceeds the 14680064 byte ceiling";
    expect(
      mailRefusalFields(
        new BrainMailClientError(400, "mail_send_request_invalid", { detail }),
      ),
    ).toEqual({
      error: "the mail service refused this message",
      reason: `mail_send_request_invalid: ${detail}`,
    });
  });

  it("still refuses legibly when the service named no figures", () => {
    expect(
      mailRefusalFields(new BrainMailClientError(400, "mail_send_request_invalid")),
    ).toEqual({
      error: "the mail service refused this message",
      reason: "mail_send_request_invalid",
    });
  });

  /** A code with no branch of its own keeps its code and says the service
   *  refused, rather than guessing a cause. */
  it("keeps an unmapped code as itself", () => {
    expect(
      mailRefusalFields(new BrainMailClientError(409, "mail_thread_stale")),
    ).toEqual({
      error: "the mail service refused this request",
      reason: "mail_thread_stale",
    });
  });
});
