import { describe, expect, it } from "vitest";

import type { MailEndpoint, MailProtocol } from "../ports";
import { validateResolvedMailTargets } from "../security";
import { ImapFlowSentCopyAdapter } from "./imap-sent-copy";

const ACCOUNT = `account-a${"8".repeat(32)}`;

interface FakeClientScript {
  readonly authenticated?: boolean | string;
  readonly secureConnection?: boolean;
  /** LIST entries as ImapFlow hands them over. */
  readonly mailboxes?: readonly {
    readonly path: string;
    readonly name?: string;
    readonly delimiter?: string;
    /** What the server itself listed for the folder. */
    readonly flags?: Set<string>;
    /** ImapFlow's own reading: the flag, or a guess from the folder's name. */
    readonly specialUse?: string;
  }[];
  readonly searchUids?: readonly number[];
  readonly appendResult?:
    | { readonly destination: string; readonly uidValidity?: bigint; readonly uid?: number }
    | false;
}

function createAdapter(script: FakeClientScript) {
  const events: string[] = [];
  const dns = {
    async resolve(_protocol: MailProtocol, endpoint: MailEndpoint) {
      return validateResolvedMailTargets(
        "imap",
        endpoint,
        {
          resolutionId: "dns-r2",
          resolvedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          addresses: [{ address: "93.184.216.40", family: 4 as const }],
        },
        Date.now(),
      );
    },
  };
  const password = Buffer.from("swordfish", "utf8");
  const adapter = new ImapFlowSentCopyAdapter({
    dns,
    access: {
      async resolveImapAccess() {
        return Object.freeze({
          endpoint: Object.freeze({
            hostname: "imap.test.local",
            port: 993,
            tls: "implicit" as const,
          }),
          username: "user@test.local",
          readPassword: async () => password,
        });
      },
    },
    createClient: (options) => {
      events.push(`client:${options.host}:${options.port}`);
      return {
        secureConnection: script.secureConnection ?? true,
        authenticated: script.authenticated ?? true,
        connect: async () => {
          events.push("connect");
        },
        logout: async () => {
          events.push("logout");
        },
        close: () => {
          events.push("close");
        },
        on: function on() {
          return this;
        },
        list: async () => {
          events.push("list");
          return (
            script.mailboxes ?? [
              { path: "INBOX", delimiter: "/", flags: new Set<string>() },
              // A folder under a name no list knows, which the server marks.
              {
                path: "Sent Items",
                name: "Outgoing letters",
                delimiter: "/",
                flags: new Set(["\\Sent"]),
                specialUse: "\\Sent",
              },
            ]
          );
        },
        mailboxOpen: async (path: string) => {
          events.push(`open:${path}`);
          return { uidValidity: BigInt(31) };
        },
        search: async () => {
          events.push("search");
          return script.searchUids ?? [];
        },
        append: async (path: string) => {
          events.push(`append:${path}`);
          return script.appendResult ?? false;
        },
      };
    },
  });
  return { adapter, events, password };
}

const signal = new AbortController().signal;

describe("ImapFlow Sent copy adapter", () => {
  it("finds an existing Message-ID in the special-use Sent mailbox", async () => {
    const { adapter, events, password } = createAdapter({
      searchUids: [11, 44],
    });
    const lookup = await adapter.findByMessageId({
      accountId: ACCOUNT,
      messageId: "<brain.copy.1@test.local>",
      deadlineAt: Date.now() + 10_000,
      signal,
    });

    expect(lookup).toEqual({
      kind: "found",
      mailboxId: "sent",
      uidValidity: "31",
      uid: 44,
    });
    expect(events).toContain("client:93.184.216.40:993");
    expect(events).toContain("open:Sent Items");
    expect(password.every((byte) => byte === 0)).toBe(true);
  });

  it("reports a definitive miss as absent", async () => {
    const { adapter } = createAdapter({ searchUids: [] });
    await expect(
      adapter.findByMessageId({
        accountId: ACCOUNT,
        messageId: "<brain.copy.2@test.local>",
        deadlineAt: Date.now() + 10_000,
        signal,
      }),
    ).resolves.toEqual({ kind: "absent", mailboxId: "sent" });
  });

  it("degrades to unavailable when authentication fails", async () => {
    const { adapter } = createAdapter({ authenticated: false });
    await expect(
      adapter.findByMessageId({
        accountId: ACCOUNT,
        messageId: "<brain.copy.3@test.local>",
        deadlineAt: Date.now() + 10_000,
        signal,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      errorCode: "sent_copy_authentication_failed",
    });
  });

  it("appends behind the durable barrier and reports the UIDPLUS result", async () => {
    const { adapter, events } = createAdapter({
      appendResult: {
        destination: "Sent Items",
        uidValidity: BigInt(31),
        uid: 907,
      },
    });
    const barrier: string[] = [];
    const result = await adapter.append(
      {
        accountId: ACCOUNT,
        operationId: "send-00000000-0000-4000-8000-000000000801",
        messageId: "<brain.copy.4@test.local>",
        raw: Buffer.from("From: me@test.local\r\n\r\nCopy\r\n", "utf8"),
        deadlineAt: Date.now() + 10_000,
        signal,
      },
      {
        deadlineAt: Date.now() + 10_000,
        beforeLiteral: async () => {
          barrier.push("beforeLiteral");
        },
      },
    );

    expect(result).toEqual({
      mailboxId: "sent",
      outcome: { kind: "stored", uidValidity: "31", uid: 907 },
    });
    const appendIndex = events.indexOf("append:Sent Items");
    expect(appendIndex).toBeGreaterThan(-1);
    expect(barrier).toEqual(["beforeLiteral"]);
  });

  it("reports a UID-less APPEND acceptance as stored_without_uid", async () => {
    const { adapter } = createAdapter({
      appendResult: { destination: "Sent Items" },
    });
    const result = await adapter.append(
      {
        accountId: ACCOUNT,
        operationId: "send-00000000-0000-4000-8000-000000000802",
        messageId: "<brain.copy.5@test.local>",
        raw: Buffer.from("From: me@test.local\r\n\r\nCopy\r\n", "utf8"),
        deadlineAt: Date.now() + 10_000,
        signal,
      },
      { deadlineAt: Date.now() + 10_000, beforeLiteral: async () => undefined },
    );
    expect(result.outcome).toEqual({ kind: "stored_without_uid" });
  });
});

/*
  Where the copy of a sent letter is appended. ImapFlow marks a folder
  `specialUse: "\\Sent"` from its leaf name when no folder carries the flag,
  at any depth, the first that matches, and that guess used to be read as the
  server's word: the owner's sent mail could be written into a project folder
  called Sent, or into a colleague's shared one. The folder is now found the
  way the Sent scan finds it, and a folder literally named Sent at the root
  stays the last resort it always was.
*/
describe("where the Sent copy goes", () => {
  const entry = (path: string, stated: string[] = [], guessed?: string) => ({
    path,
    name: path.split("/").at(-1)!,
    delimiter: "/",
    flags: new Set(["\\HasNoChildren", ...stated]),
    ...(stated.length > 0 || guessed !== undefined
      ? { specialUse: stated[0] ?? guessed }
      : {}),
  });
  const appendedTo = async (mailboxes: FakeClientScript["mailboxes"]) => {
    const { adapter, events } = createAdapter({
      mailboxes,
      appendResult: { destination: "x" },
    });
    const outcome = await adapter
      .append(
        {
          accountId: ACCOUNT,
          operationId: "send-00000000-0000-4000-8000-000000000803",
          messageId: "<brain.copy.6@test.local>",
          raw: Buffer.from("From: me@test.local\r\n\r\nCopy\r\n", "utf8"),
          deadlineAt: Date.now() + 10_000,
          signal,
        },
        { deadlineAt: Date.now() + 10_000, beforeLiteral: async () => undefined },
      )
      .then(
        () => "appended",
        (error: { errorCode?: string }) => error.errorCode ?? "failed",
      );
    return {
      outcome,
      path: events.find((event) => event.startsWith("append:"))?.slice("append:".length) ?? null,
    };
  };

  it("goes to the owner's own Sent Items, not to a project folder ImapFlow guessed", async () => {
    await expect(
      appendedTo([entry("Sent Items"), entry("Projects/Clients/Sent", [], "\\Sent")]),
    ).resolves.toEqual({ outcome: "appended", path: "Sent Items" });
  });

  it("is not appended at all when the only candidate is a colleague's shared folder", async () => {
    await expect(
      appendedTo([entry("Shared/boss/Gesendete Elemente", [], "\\Sent")]),
    ).resolves.toEqual({ outcome: "sent_mailbox_missing", path: null });
  });

  // ImapFlow names one folder per role when no folder states it, the first
  // of those its own list knows in alphabetical order of path. The fixtures
  // below put its guess where it would put it.
  it("goes to the folder ImapFlow names when two folders at the root answer to a Sent name", async () => {
    await expect(
      appendedTo([entry("Sent Items", [], "\\Sent"), entry("Sent Messages")]),
    ).resolves.toEqual({ outcome: "appended", path: "Sent Items" });
    await expect(
      appendedTo([entry("Sent Items"), entry("Sent", [], "\\Sent")]),
    ).resolves.toEqual({ outcome: "appended", path: "Sent" });
  });

  it("does not take ImapFlow's guess when it names a folder outside the two that answer", async () => {
    await expect(
      appendedTo([
        entry("Projects/Clients/Sent", [], "\\Sent"),
        entry("Sent Items"),
        entry("Sent Messages"),
      ]),
    ).resolves.toEqual({ outcome: "sent_mailbox_missing", path: null });
  });

  it("does not file a copy under a namespace prefix that is not the Inbox", async () => {
    await expect(
      appendedTo([entry("Mail/Sent", [], "\\Sent"), entry("Mail/Trash")]),
    ).resolves.toEqual({ outcome: "sent_mailbox_missing", path: null });
  });

  it("goes to the folder the server itself marks, before any name", async () => {
    await expect(
      appendedTo([entry("Outgoing", ["\\Sent"]), entry("Sent")]),
    ).resolves.toEqual({ outcome: "appended", path: "Outgoing" });
  });

  it("goes to a localized Sent folder at the root, and under the Inbox", async () => {
    await expect(appendedTo([entry("Gesendete Elemente")])).resolves.toEqual({
      outcome: "appended",
      path: "Gesendete Elemente",
    });
    await expect(
      appendedTo([{ path: "INBOX.Отправленные", name: "Отправленные", delimiter: ".", flags: new Set<string>() }]),
    ).resolves.toEqual({ outcome: "appended", path: "INBOX.Отправленные" });
  });
});
