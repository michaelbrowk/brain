// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MailRow,
  accountWords,
  stripSubjectSenderPrefix,
} from "./mail-row";
import type { MailThreadListItem } from "@/lib/mail/message-types";

function makeThread(
  overrides: Partial<MailThreadListItem> = {},
): MailThreadListItem {
  return {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    threadId: "thread-1",
    subject: "Your ticket for the Saturday matinee",
    participants: [
      { name: "Quarry Hall", address: "tickets@quarryhall.example" },
    ],
    snippet: "Your booking is confirmed",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 24_000,
    category: "people",
    ...overrides,
  };
}

describe("stripSubjectSenderPrefix", () => {
  const github = [{ name: "GitHub", address: "notifications@github.test" }];

  it("drops a bracketed prefix that repeats the sender", () => {
    expect(
      stripSubjectSenderPrefix('[GitHub] The "Daily refresh" workflow', github),
    ).toBe('The "Daily refresh" workflow');
  });

  it("matches the sending domain as well as the display name", () => {
    expect(
      stripSubjectSenderPrefix("[github.test] Run failed", github),
    ).toBe("Run failed");
  });

  it("keeps a prefix that says something the sender does not", () => {
    expect(stripSubjectSenderPrefix("[Urgent] Run failed", github)).toBe(
      "[Urgent] Run failed",
    );
    expect(stripSubjectSenderPrefix("[RFC 9110] Semantics", github)).toBe(
      "[RFC 9110] Semantics",
    );
  });
});

describe("accountWords", () => {
  const words = (addresses: readonly string[]) => [
    ...accountWords(addresses).values(),
  ];

  it("is the local part, lowercased, while the local part is unique", () => {
    expect(words(["Design@personal.test"])).toEqual(["design"]);
    expect(words(["misha@example.test", "anna@example.test"])).toEqual([
      "misha",
      "anna",
    ]);
  });

  it("falls to the domain's first label when local parts collide", () => {
    expect(
      words([
        "misha@example.test",
        "misha@studio.example",
        "p.hart@work.example",
      ]),
    ).toEqual(["example", "studio", "work"]);
  });

  it("takes the shortest token, so a long local part yields to its domain", () => {
    expect(words(["p.hart@work.example"])).toEqual(["work"]);
  });

  it("falls to the address in full when every token is shared", () => {
    expect(words(["misha@studio.example", "misha@studio.test"])).toEqual([
      "misha@studio.example",
      "misha@studio.test",
    ]);
  });

  it("costs only the accounts that collide", () => {
    expect(
      words([
        "misha@example.test",
        "misha@studio.example",
        "studio@work.example",
      ]),
    ).toEqual(["example", "studio", "work"]);
  });

  it("answers the same whatever order the accounts arrive in", () => {
    const set = [
      "misha@example.test",
      "misha@studio.example",
      "p.hart@work.example",
    ];
    const forward = accountWords(set);
    const backward = accountWords([...set].reverse());
    for (const address of set) {
      expect(backward.get(address)).toBe(forward.get(address));
    }
  });
});

describe("MailRow", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function render(thread: MailThreadListItem, account?: string) {
    await act(async () =>
      root.render(
        <MailRow
          thread={thread}
          active={false}
          account={account}
          timeLabel="18:24"
          onSelect={() => {}}
        />,
      ),
    );
    return host.querySelector("button")!;
  }

  it("continues the subject with the snippet after a separator", async () => {
    const row = await render(makeThread());
    expect(row.textContent).toContain(
      "Your ticket for the Saturday matinee · Your booking is confirmed",
    );
  });

  it("ends the line rather than saying there is no preview", async () => {
    const row = await render(makeThread({ snippet: null }));
    expect(row.textContent).not.toContain("No preview");
    expect(row.textContent).toContain("Your ticket for the Saturday matinee");
    expect(row.textContent).not.toContain("·");
  });

  it("puts the unread dot in its own rail, not inside the text", async () => {
    const unread = await render(makeThread({ unread: true }));
    expect(unread.querySelector(".brain-mail-rail .brain-mail-dot")).not.toBeNull();
    const read = await render(makeThread({ unread: false }));
    expect(read.querySelector(".brain-mail-rail")).not.toBeNull();
    expect(read.querySelector(".brain-mail-dot")).toBeNull();
  });

  it("makes the message count a chip beside the sender", async () => {
    const row = await render(makeThread({ messageCount: 4 }));
    const chip = row.querySelector(".brain-mail-count");
    expect(chip?.textContent).toBe("4");
    // and it stands before the meta column, never left of the date
    const time = row.querySelector("time");
    expect(
      chip!.compareDocumentPosition(time!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("names the source account only when it is given one", async () => {
    const withAccount = await render(makeThread(), "design");
    expect(withAccount.textContent).toContain("design");
    const without = await render(makeThread());
    expect(without.textContent).not.toContain("design");
  });

  it("lets the subject and snippet resolve their own direction", async () => {
    const row = await render(makeThread());
    expect(row.querySelectorAll('[dir="auto"]').length).toBeGreaterThanOrEqual(2);
  });

  it("drops a bracketed prefix that only repeats the sender", async () => {
    const row = await render(
      makeThread({
        subject: "[Quarry Hall] Your ticket",
        participants: [
          { name: "Quarry Hall", address: "t@quarryhall.example" },
        ],
      }),
    );
    expect(row.textContent).toContain("Your ticket");
    expect(row.textContent).not.toContain("[Quarry Hall]");
  });
});
