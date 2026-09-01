import { createRequire } from "node:module";
import {
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import {
  createSecureContext,
  createServer as createTlsServer,
  TLSSocket,
  type Server as TlsServer,
} from "node:tls";
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";

import type { MailDnsResolverPort, ValidatedMailDialTarget } from "../ports";
import { ImapFlowCredentialVerifier } from "./imapflow-adapter";

const require = createRequire(import.meta.url);
const testTls = require("imapflow/test/fixtures/test-tls.js") as {
  readonly cert: string;
  readonly key: string;
};
const servers: Array<NetServer | TlsServer> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("ImapFlow verifier against a real fake IMAP server", () => {
  it("authenticates over implicit TLS and proves the observed peer", async () => {
    const commands: string[] = [];
    const server = createTlsServer(testTls, (socket) => {
      serveAuthenticatedImap(socket, commands);
    });
    const port = await listen(server);

    await expect(verifierFor(port, "implicit").verify(requestFor(port, "implicit")))
      .resolves.toBeUndefined();

    expect(commandNames(commands)).toEqual([
      "CAPABILITY",
      "LOGIN",
      "CAPABILITY",
      "LIST",
    ]);
    expect(commands.find((line) => line.includes("LOGIN"))).toContain(
      "test-only-password",
    );
  });

  it("never sends credentials before a required STARTTLS upgrade", async () => {
    const plaintextCommands: string[] = [];
    const encryptedCommands: string[] = [];
    const secureContext = createSecureContext(testTls);
    const server = createNetServer((socket) => {
      serveStartTlsImap(
        socket,
        secureContext,
        plaintextCommands,
        encryptedCommands,
      );
    });
    const port = await listen(server);

    await expect(verifierFor(port, "starttls").verify(requestFor(port, "starttls")))
      .resolves.toBeUndefined();

    expect(commandNames(plaintextCommands)).toEqual(["CAPABILITY", "STARTTLS"]);
    expect(plaintextCommands.join("\n")).not.toContain("test-only-password");
    expect(commandNames(encryptedCommands)).toEqual([
      "CAPABILITY",
      "LOGIN",
      "CAPABILITY",
      "LIST",
    ]);
  });
});

function verifierFor(port: number, tls: "implicit" | "starttls") {
  const target = targetFor(port, tls);
  const dns: MailDnsResolverPort = { resolve: async () => [target] };
  return new ImapFlowCredentialVerifier({
    dns,
    createClient: (options: ImapFlowOptions) =>
      new ImapFlow({
        ...options,
        tls: { ...options.tls, ca: testTls.cert },
      }),
  });
}

function requestFor(port: number, tls: "implicit" | "starttls") {
  return {
    endpoint: { hostname: "localhost", port, tls },
    username: "person@example.test",
    password: Buffer.from("test-only-password"),
    deadlineAt: Date.now() + 5_000,
    signal: new AbortController().signal,
  };
}

function targetFor(
  port: number,
  tls: "implicit" | "starttls",
): ValidatedMailDialTarget {
  const now = Date.now();
  return {
    protocol: "imap",
    hostname: "localhost",
    port,
    tls,
    address: "127.0.0.1",
    family: 4,
    resolutionId: "dns-fake-imap",
    resolvedAt: now,
    expiresAt: now + 5_000,
  };
}

function serveStartTlsImap(
  socket: Socket,
  secureContext: ReturnType<typeof createSecureContext>,
  plaintextCommands: string[],
  encryptedCommands: string[],
): void {
  socket.write("* OK fake IMAP ready\r\n");
  attachLineReader(socket, plaintextCommands, (tag, command) => {
    if (command === "CAPABILITY") {
      socket.write(
        `* CAPABILITY IMAP4rev1 STARTTLS\r\n${tag} OK CAPABILITY completed\r\n`,
      );
      return;
    }
    if (command !== "STARTTLS") {
      socket.write(`${tag} BAD TLS required\r\n`);
      return;
    }
    socket.write(`${tag} OK Begin TLS negotiation\r\n`, () => {
      socket.removeAllListeners("data");
      const tlsSocket = new TLSSocket(socket, {
        isServer: true,
        secureContext,
      });
      tlsSocket.once("error", () => undefined);
      serveAuthenticatedImap(tlsSocket, encryptedCommands, false);
    });
  });
}

function serveAuthenticatedImap(
  socket: Socket | TLSSocket,
  commands: string[],
  greet = true,
): void {
  socket.once("error", () => undefined);
  if (greet) socket.write("* OK fake IMAP ready\r\n");
  attachLineReader(socket, commands, (tag, command) => {
    if (command === "CAPABILITY") {
      socket.write(
        `* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`,
      );
      return;
    }
    if (command === "LOGIN") {
      socket.write(`${tag} OK LOGIN completed\r\n`);
      return;
    }
    if (command === "NAMESPACE") {
      socket.write(
        `* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`,
      );
      return;
    }
    if (command === "LIST") {
      socket.write(
        `* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`,
      );
      return;
    }
    socket.write(`${tag} BAD unsupported test command\r\n`);
  });
}

function attachLineReader(
  socket: Socket | TLSSocket,
  commands: string[],
  respond: (tag: string, command: string) => void,
): void {
  let buffered = "";
  socket.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    while (buffered.includes("\r\n")) {
      const separator = buffered.indexOf("\r\n");
      const line = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 2);
      if (line.length === 0) continue;
      commands.push(line);
      const [tag = "", command = ""] = line.split(/\s+/, 3);
      respond(tag, command.toUpperCase());
    }
  });
}

function commandNames(lines: readonly string[]): string[] {
  return lines.map((line) => line.split(/\s+/, 3)[1]?.toUpperCase() ?? "");
}

async function listen(server: NetServer | TlsServer): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake IMAP server has no TCP port");
  }
  return address.port;
}

function closeServer(server: NetServer | TlsServer): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve) => server.close(() => resolve()));
}
