import net from "node:net";
import tls from "node:tls";

/**
 * Deterministic TLS material for the in-process fake SMTP server. The leaf
 * certificates are issued by a dedicated throwaway test CA (EC P-256, expiry
 * 2126) so the wire client can keep certificate verification enabled and pin
 * this CA through its trustedRootCertificates test seam. Never use these keys
 * outside tests.
 */
export const SMTP_TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBkDCCATegAwIBAgIUCzQVvDFudNxuMA67GikYLnPr2q0wCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYnJhaW4tbWFpbC10ZXN0LWNhMCAXDTI2MDcyMDA4MzUzNFoY
DzIxMjYwNjI2MDgzNTM0WjAdMRswGQYDVQQDDBJicmFpbi1tYWlsLXRlc3QtY2Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATxaQYrrupkESZFexF5tfUYMDb9rYlP
I/hFNO2Q6gQCNRYEcag6k7/kQYoYpiIJkQ3dT2ip5ZlrEpH+vLSE73QPo1MwUTAd
BgNVHQ4EFgQU8NWOVA26XoAO2QDF9lRmi5a6qzYwHwYDVR0jBBgwFoAU8NWOVA26
XoAO2QDF9lRmi5a6qzYwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBE
Ah8bd/bQIAmfygjbHTkMyKdJ0KQ0o+tgss4mUqfPWZ2sAiEA1F9tAl2Yy8LafPFc
717VWp3QKmqdI/a6bddg5wkR6Ck=
-----END CERTIFICATE-----
`;

/** Leaf for the expected hostname smtp.test.local. */
export const SMTP_TEST_SERVER_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIHVUMXytx+uJxr4ClKxVyFWl+bppG8OMrAF+5GXlbJamoAoGCCqGSM49
AwEHoUQDQgAEwp/x93FNSJScjzxPaufbo7LjjHUnxw6YBZOLS7zJg9HRDuS5ed4G
dWL1KbUWBnPaxneKOSOGj6s+SA2hoa1+2g==
-----END EC PRIVATE KEY-----
`;

export const SMTP_TEST_SERVER_CERT = `-----BEGIN CERTIFICATE-----
MIIBpDCCAUqgAwIBAgIUDNsKZHmeSwJ+47dAj/0S/7ITVPAwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYnJhaW4tbWFpbC10ZXN0LWNhMCAXDTI2MDcyMDA4MzUzNFoY
DzIxMjYwNjI2MDgzNTM0WjAaMRgwFgYDVQQDDA9zbXRwLnRlc3QubG9jYWwwWTAT
BgcqhkjOPQIBBggqhkjOPQMBBwNCAATCn/H3cU1IlJyPPE9q59ujsuOMdSfHDpgF
k4tLvMmD0dEO5Ll53gZ1YvUptRYGc9rGd4o5I4aPqz5IDaGhrX7ao2kwZzAaBgNV
HREEEzARgg9zbXRwLnRlc3QubG9jYWwwCQYDVR0TBAIwADAdBgNVHQ4EFgQUSg4o
ifi7b68NSkLVBrf6inNbRWcwHwYDVR0jBBgwFoAU8NWOVA26XoAO2QDF9lRmi5a6
qzYwCgYIKoZIzj0EAwIDSAAwRQIgF8CzazRq/pdz4ORr5nPF1aGE9RUU4aYKsptC
jFPqKZwCIQD8afA9m0zm+wrYmyP2Fgf0cbg2LswkATC87OcfwNY3qw==
-----END CERTIFICATE-----
`;

/** Leaf for wrong.example: valid chain, wrong hostname for smtp.test.local. */
export const SMTP_TEST_WRONG_HOST_KEY = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIDr45k1e7daRPJ88w+6iZqRELAAW03W5twu8iXDjy0cMoAoGCCqGSM49
AwEHoUQDQgAERoG7d8HUHrg61EpRWzI+X7LiuTxultpHsPa4M80Qsqrte0tl649v
Pss/qQRVvdyRzfNiVFxtCxFBWwlH/v69ZQ==
-----END EC PRIVATE KEY-----
`;

export const SMTP_TEST_WRONG_HOST_CERT = `-----BEGIN CERTIFICATE-----
MIIBoDCCAUagAwIBAgIUDNsKZHmeSwJ+47dAj/0S/7ITVPEwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYnJhaW4tbWFpbC10ZXN0LWNhMCAXDTI2MDcyMDA4MzUzNFoY
DzIxMjYwNjI2MDgzNTM0WjAYMRYwFAYDVQQDDA13cm9uZy5leGFtcGxlMFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAERoG7d8HUHrg61EpRWzI+X7LiuTxultpHsPa4
M80Qsqrte0tl649vPss/qQRVvdyRzfNiVFxtCxFBWwlH/v69ZaNnMGUwGAYDVR0R
BBEwD4INd3JvbmcuZXhhbXBsZTAJBgNVHRMEAjAAMB0GA1UdDgQWBBS28CPvufFr
ahJ3UwPxyfAKDwRK1jAfBgNVHSMEGDAWgBTw1Y5UDbpegA7ZAMX2VGaLlrqrNjAK
BggqhkjOPQQDAgNIADBFAiEAzFXQCuNgH4J3IQj+ywJzJ4BMTN/p1Qysq3CRj7Kl
LGsCIDC70KcxXtgK0fLeIGDz8ZLg68aaY5CmPNf/+YZ8YsU7
-----END CERTIFICATE-----
`;

export type FakeSmtpFinalBehavior = number | "silence" | "close";

export interface FakeSmtpServerOptions {
  /** Wire mode. "starttls-unavailable" answers EHLO without the capability. */
  readonly mode: "implicit" | "starttls" | "starttls-unavailable";
  readonly certificate?: "good" | "wrong_hostname";
  /** Reply code for the AUTH exchange. Default 235. */
  readonly authCode?: number;
  /** Reply code for MAIL FROM. Default 250. */
  readonly mailFromCode?: number;
  /** Per-address RCPT reply codes. Default 250. */
  readonly rcptCodes?: Readonly<Record<string, number>>;
  /** Reply code for the DATA command itself. Default 354. */
  readonly dataCode?: number;
  /** Behavior after the terminating dot. Default 250. */
  readonly finalBehavior?: FakeSmtpFinalBehavior;
}

interface FakeSmtpConnectionState {
  socket: net.Socket | tls.TLSSocket;
  buffered: Buffer;
  inData: boolean;
  tlsActive: boolean;
}

/**
 * Real in-process SMTP server for integration tests. It speaks actual TCP and
 * TLS (implicit and STARTTLS upgrades) with scripted response codes, records
 * every command line, and captures the DATA payload.
 */
export class FakeSmtpServer {
  readonly commands: string[] = [];
  readonly authLines: string[] = [];
  dataPayload: Buffer | null = null;
  sawAuthBeforeTls = false;
  port = 0;
  private server!: net.Server | tls.Server;

  private constructor(private readonly options: FakeSmtpServerOptions) {}

  static async start(options: FakeSmtpServerOptions): Promise<FakeSmtpServer> {
    const instance = new FakeSmtpServer(options);
    const certificate = options.certificate ?? "good";
    const tlsContext = {
      key:
        certificate === "good"
          ? SMTP_TEST_SERVER_KEY
          : SMTP_TEST_WRONG_HOST_KEY,
      cert:
        certificate === "good"
          ? SMTP_TEST_SERVER_CERT
          : SMTP_TEST_WRONG_HOST_CERT,
    };
    const onConnection = (socket: net.Socket | tls.TLSSocket) => {
      instance.handleConnection(socket, tlsContext);
    };
    instance.server =
      options.mode === "implicit"
        ? tls.createServer(tlsContext, onConnection)
        : net.createServer(onConnection);
    await new Promise<void>((resolve, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(0, "127.0.0.1", () => {
        instance.server.off("error", reject);
        resolve();
      });
    });
    const address = instance.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("fake SMTP server has no port");
    }
    instance.port = address.port;
    return instance;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleConnection(
    socket: net.Socket | tls.TLSSocket,
    tlsContext: { readonly key: string; readonly cert: string },
  ): void {
    socket.on("error", () => undefined);
    const state: FakeSmtpConnectionState = {
      socket,
      buffered: Buffer.alloc(0),
      inData: false,
      tlsActive: this.options.mode === "implicit",
    };
    const attach = (active: net.Socket | tls.TLSSocket) => {
      active.on("data", (chunk: Buffer) => {
        state.buffered = Buffer.concat([state.buffered, chunk]);
        this.drain(state, tlsContext, attach);
      });
      active.on("error", () => undefined);
    };
    attach(socket);
    socket.write("220 smtp.test.local ESMTP fake\r\n");
  }

  private drain(
    state: FakeSmtpConnectionState,
    tlsContext: { readonly key: string; readonly cert: string },
    attach: (socket: net.Socket | tls.TLSSocket) => void,
  ): void {
    while (true) {
      if (state.inData) {
        const terminator = state.buffered.indexOf("\r\n.\r\n");
        if (terminator === -1) return;
        this.dataPayload = state.buffered.subarray(0, terminator + 2);
        state.buffered = state.buffered.subarray(terminator + 5);
        state.inData = false;
        const behavior = this.options.finalBehavior ?? 250;
        if (behavior === "silence") continue;
        if (behavior === "close") {
          state.socket.destroy();
          return;
        }
        state.socket.write(`${behavior} ${behavior === 250 ? "queued as fake" : "no"}\r\n`);
        continue;
      }
      const index = state.buffered.indexOf("\r\n");
      if (index === -1) return;
      const line = state.buffered.subarray(0, index).toString("utf8");
      state.buffered = state.buffered.subarray(index + 2);
      this.commands.push(line);
      const keyword = line.split(" ", 1)[0]?.toUpperCase() ?? "";
      if (keyword === "EHLO") {
        const capabilities = ["250-smtp.test.local greets you"];
        if (this.options.mode === "starttls" && !state.tlsActive) {
          capabilities.push("250-STARTTLS");
        }
        capabilities.push("250 AUTH PLAIN LOGIN");
        state.socket.write(`${capabilities.join("\r\n")}\r\n`);
        continue;
      }
      if (keyword === "STARTTLS") {
        if (this.options.mode !== "starttls") {
          state.socket.write("454 TLS not available\r\n");
          continue;
        }
        state.socket.write("220 ready for TLS\r\n");
        const plain = state.socket as net.Socket;
        plain.removeAllListeners("data");
        const secured = new tls.TLSSocket(plain, {
          isServer: true,
          secureContext: tls.createSecureContext(tlsContext),
        });
        state.socket = secured;
        state.tlsActive = true;
        state.buffered = Buffer.alloc(0);
        attach(secured);
        return;
      }
      if (keyword === "AUTH" || line.startsWith("AUTH")) {
        if (!state.tlsActive) this.sawAuthBeforeTls = true;
        this.authLines.push(line);
        state.socket.write(`${this.options.authCode ?? 235} auth\r\n`);
        continue;
      }
      if (keyword === "MAIL") {
        state.socket.write(`${this.options.mailFromCode ?? 250} sender ok\r\n`);
        continue;
      }
      if (keyword === "RCPT") {
        const address = /<([^>]*)>/.exec(line)?.[1] ?? "";
        const code = this.options.rcptCodes?.[address] ?? 250;
        state.socket.write(`${code} recipient\r\n`);
        continue;
      }
      if (keyword === "DATA") {
        const code = this.options.dataCode ?? 354;
        state.socket.write(
          `${code} ${code === 354 ? "send it" : "no"}\r\n`,
        );
        if (code === 354) state.inData = true;
        continue;
      }
      if (keyword === "QUIT") {
        state.socket.write("221 bye\r\n");
        state.socket.end();
        return;
      }
      state.socket.write("500 unrecognized\r\n");
    }
  }
}
