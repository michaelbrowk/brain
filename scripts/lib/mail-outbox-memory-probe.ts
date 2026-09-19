/**
 * What a send at a given attachment size costs the mail service in memory.
 *
 *   node <this, bundled> --size 8 [--runs 3] [--batch 20]
 *
 * Prints one peak per stage, per run, in MiB, against `MemoryHigh` from
 * `MAIL_PROCESS_LIMITS`. The figure is `process.resourceUsage().maxRSS`, a
 * high-water mark over a whole process, which is why each stage runs in its own
 * process: stages that never coexist in the service would otherwise add up into
 * a peak that never happens.
 *
 * The four stages are the four the service actually has:
 *
 *   build    the request body off the socket, decoded, parsed, validated, and
 *            the MIME message written. `POST /v1/send` up to the store.
 *   enqueue  the same request carrying on into `store.enqueue`: the row's JSON,
 *            the message into its BLOB column, the insert.
 *   read     the later turn that reads one row back to deliver it, in a fresh
 *            process, because it never overlaps the build. It stops where the
 *            provider starts: Gmail then base64s the message and `JSON.stringify`s
 *            that into a request body, two more full-size strings, so the real
 *            delivery peak for a Gmail account is this figure plus about twice
 *            the message. The `drain` stage below carries that cost.
 *   drain    the outbound worker's own pass over a backlog: `--batch` rows at
 *            the same size, listed and delivered in one `runNow`, through a
 *            provider that makes the base64 and the JSON body Gmail's adapter
 *            makes. This is the stage a batch read turns into memory.
 *
 * The request body is written by a separate step, so the cost of making
 * megabytes of base64 never lands on the service's mark. The payload is
 * low-entropy on purpose: it is the size that is being measured, not zlib.
 *
 * Self-contained once bundled: no network, no server, no account, and no
 * dependency on the repository being present. `pnpm build:probe` writes the
 * bundle, and the release ships it so the droplet can take the same reading
 * against the contract that actually applies to it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { sendRequestBody } from "../../lib/mail/providers/gmail/send-adapter";
import { MAIL_PROCESS_LIMITS } from "../../lib/mail/security";
import {
  createMailSendSubmissionProposal,
  ProviderNeutralMailSendService,
  runExclusiveOutboundBuild,
  validateMailSendInput,
  type MailSendAccount,
  type MailSendProvider,
} from "../../lib/mail/service/outbound";
import { SqliteMailSendStore } from "../../lib/mail/service/outbound-store";
import { MailOutboundWorker } from "../../lib/mail/service/outbound-worker";

const ACCOUNT: MailSendAccount = Object.freeze({
  accountId: `account-a${"1".repeat(32)}`,
  providerKind: "gmail" as const,
  emailAddress: "sender@example.test",
  status: "connected" as const,
});
const CREATED_AT = 1_800_000_000_000;
const STAGES = ["build", "enqueue", "read", "drain"] as const;

type Stage = (typeof STAGES)[number];

function operationId(index: number): string {
  return `send-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function report(): void {
  process.stdout.write(
    `maxRSS ${process.resourceUsage().maxRSS / 1024}\n`,
  );
}

/** The client's side, so its own copies never land on the service's mark. */
function prepare(bodyPath: string, bytes: number): void {
  const payload = Buffer.alloc(bytes, 7).toString("base64");
  writeFileSync(
    bodyPath,
    JSON.stringify({
      accountId: ACCOUNT.accountId,
      idempotencyKey: "probe-1",
      mode: "compose",
      to: ["friend@example.net"],
      cc: [],
      bcc: [],
      subject: "Probe",
      text: "One line of body beside the file.\n",
      replyToMessageId: null,
      attachments: [
        {
          filename: "payload.bin",
          mimeType: "application/octet-stream",
          dataBase64: payload,
        },
      ],
      origin: "app",
      agentLine: false,
    }),
  );
}

/** Everything the request does before the store, as the service does it. */
async function buildProposal(bodyPath: string, index = 1) {
  const body = readFileSync(bodyPath);
  const input = validateMailSendInput(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
  );
  return runExclusiveOutboundBuild(() =>
    createMailSendSubmissionProposal({
      account: ACCOUNT,
      input,
      reply: null,
      operationId: operationId(index),
      createdAt: CREATED_AT,
    }),
  );
}

async function openStore(cacheRoot: string): Promise<SqliteMailSendStore> {
  mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const store = new SqliteMailSendStore({ cacheRoot, now: () => CREATED_AT });
  await store.initialize();
  return store;
}

/**
 * What the transport costs on top of the store.
 *
 * `gmail` calls the Gmail adapter's own `sendRequestBody`: one buffer with the
 * message encoded into it a chunk at a time, which is what a delivery to a Gmail
 * account allocates. Imported rather than reproduced, because the outgoing cap
 * rests on this figure and a copy would keep reporting the old one after the
 * adapter changed. `bytes` is what the SMTP path does — one Buffer copy with
 * the Bcc header stripped — and it is also the shape that isolates the store's
 * own share of a drain. Both are real; the difference between them belongs to
 * the provider rather than to the outbox.
 */
function costingProvider(shape: "gmail" | "bytes"): MailSendProvider {
  return {
    providerKind: "gmail",
    send: async (message, hooks) => {
      await hooks.beforeDelivery();
      if (shape === "gmail") {
        const body = sendRequestBody(message);
        if (body.byteLength < 1) throw new Error("empty body");
      } else if (message.rawRfc2822.byteLength < 1) {
        throw new Error("empty message");
      }
      return {
        kind: "accepted" as const,
        providerMessageId: `gmail-${message.operationId.slice(-12)}`,
        providerThreadId: `thread-${message.operationId.slice(-12)}`,
      };
    },
  };
}

function serviceFor(store: SqliteMailSendStore, shape: "gmail" | "bytes") {
  return new ProviderNeutralMailSendService({
    store,
    accounts: {
      readSendAccount: async () => ACCOUNT,
    },
    replies: { resolveReplyContext: async () => null },
    providers: [costingProvider(shape)],
    now: () => CREATED_AT,
  });
}

async function runStage(
  stage: string,
  bodyPath: string,
  cacheRoot: string,
  count: number,
  shape: "gmail" | "bytes",
): Promise<void> {
  if (stage === "limits") {
    process.stdout.write(
      `memoryHigh ${MAIL_PROCESS_LIMITS.memoryHighBytes / (1024 * 1024)}\n`,
    );
    return;
  }
  if (stage === "prepare") {
    prepare(bodyPath, count);
    return;
  }
  if (stage === "build") {
    await buildProposal(bodyPath);
    report();
    return;
  }
  if (stage === "enqueue") {
    const proposal = await buildProposal(bodyPath);
    const store = await openStore(cacheRoot);
    await store.enqueue(proposal);
    await store.close();
    report();
    return;
  }
  if (stage === "read") {
    const store = await openStore(cacheRoot);
    const stored = await store.readByOperationId(operationId(1));
    if (stored === null) throw new Error("the enqueue stage wrote no row");
    // What delivery does with the row before it reaches the transport.
    const digest = createHash("sha256")
      .update(stored.message.rawRfc2822)
      .digest("hex");
    if (
      digest !== stored.message.rawRfc2822Sha256 ||
      stored.message.rawRfc2822.byteLength !== stored.message.rawRfc2822Bytes
    ) {
      throw new Error("the row did not read back whole");
    }
    await store.close();
    report();
    return;
  }
  if (stage === "fill") {
    // One build, `count` rows: the backlog the drain stage measures, without
    // paying for `count` MIME builds to make it.
    const proposal = await buildProposal(bodyPath);
    const store = await openStore(cacheRoot);
    for (let index = 1; index <= count; index += 1) {
      await store.enqueue({
        ...proposal,
        operationId: operationId(index),
        idempotencyKey: `probe-${index}`,
      });
    }
    await store.close();
    return;
  }
  if (stage === "drain") {
    const store = await openStore(cacheRoot);
    const worker = new MailOutboundWorker({
      store,
      processor: serviceFor(store, shape),
      now: () => CREATED_AT,
      batchSize: count,
    });
    await worker.runNow();
    await worker.stop();
    const left = await store.countActive();
    if (left !== 0) throw new Error(`the drain left ${left} operations queued`);
    await store.close();
    report();
    return;
  }
  throw new Error(`unknown stage: ${stage}`);
}

interface Options {
  readonly sizes: number[];
  runs: number;
  batch: number;
  shape: "gmail" | "bytes";
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = { sizes: [], runs: 3, batch: 20, shape: "gmail" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--size" || flag === "--sizes") {
      for (const size of String(value).split(",")) {
        const mib = Number(size);
        if (!Number.isFinite(mib) || mib <= 0) {
          throw new Error(`--size takes mebibytes, not ${size}`);
        }
        options.sizes.push(mib);
      }
      index += 1;
    } else if (flag === "--runs" || flag === "--batch") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error(`${flag} takes a whole number`);
      }
      if (flag === "--runs") options.runs = parsed;
      else options.batch = parsed;
      index += 1;
    } else if (flag === "--provider") {
      if (value !== "gmail" && value !== "bytes") {
        throw new Error("--provider takes gmail or bytes");
      }
      options.shape = value;
      index += 1;
    } else {
      throw new Error(
        "usage: mail-outbox-memory-probe --size 8 [--runs 3] [--batch 20] " +
          "[--provider gmail|bytes]",
      );
    }
  }
  if (options.sizes.length === 0) options.sizes.push(8);
  return options;
}

function spawnStage(
  stage: string,
  bodyPath: string,
  cacheRoot: string,
  count: number,
  shape: "gmail" | "bytes" = "gmail",
): number {
  const result = spawnSync(
    process.execPath,
    [
      process.argv[1]!,
      "--stage",
      stage,
      bodyPath,
      cacheRoot,
      String(count),
      shape,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`stage ${stage} exited ${String(result.status)}`);
  }
  if (stage === "prepare" || stage === "fill") return 0;
  const field = stage === "limits" ? "memoryHigh" : "maxRSS";
  const match = new RegExp(`^${field} (\\d+(?:\\.\\d+)?)$`, "m").exec(
    result.stdout,
  );
  if (!match) throw new Error(`stage ${stage} printed no figure`);
  return Number(match[1]);
}

/** A bare `node` on this machine, so a peak can be read against something. */
function baseline(): number {
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.resourceUsage().maxRSS / 1024))"],
    { encoding: "utf8" },
  );
  return Number(result.stdout);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--stage") {
    await runStage(
      argv[1]!,
      argv[2]!,
      argv[3]!,
      Number(argv[4]),
      argv[5] === "bytes" ? "bytes" : "gmail",
    );
    return;
  }
  const options = parseArguments(argv);
  const workspace = mkdtempSync(path.join(tmpdir(), "brain-outbox-probe-"));
  try {
    const memoryHigh = spawnStage("limits", "", "", 0);
    process.stdout.write(
      `node ${process.version} on ${process.platform}, bare-node baseline ` +
        `${baseline().toFixed(1)} MiB, MemoryHigh ${memoryHigh} MiB, ` +
        `drain batch ${options.batch} through the ${options.shape} transport\n\n`,
    );
    process.stdout.write("| attachment | stage | runs (MiB) | worst |\n");
    process.stdout.write("| ---: | --- | --- | ---: |\n");

    for (const mib of options.sizes) {
      const bytes = Math.round(mib * 1024 * 1024);
      const peaks = new Map<Stage, number[]>(
        STAGES.map((stage) => [stage, [] as number[]]),
      );
      for (let run = 0; run < options.runs; run += 1) {
        const runRoot = path.join(workspace, `run-${mib}-${run}`);
        const drainRoot = path.join(workspace, `drain-${mib}-${run}`);
        const bodyPath = path.join(workspace, `body-${mib}-${run}.json`);
        spawnStage("prepare", bodyPath, runRoot, bytes);
        for (const stage of ["build", "enqueue", "read"] as const) {
          peaks.get(stage)!.push(spawnStage(stage, bodyPath, runRoot, bytes));
        }
        spawnStage("fill", bodyPath, drainRoot, options.batch);
        peaks
          .get("drain")!
          .push(
            spawnStage("drain", bodyPath, drainRoot, options.batch, options.shape),
          );
        rmSync(bodyPath, { force: true });
        rmSync(runRoot, { recursive: true, force: true });
        rmSync(drainRoot, { recursive: true, force: true });
      }
      for (const stage of STAGES) {
        const runs = peaks.get(stage)!;
        const worst = Math.max(...runs);
        const label = stage === "drain" ? `drain ×${options.batch}` : stage;
        process.stdout.write(
          `| ${mib} MiB | ${label} | ${runs
            .map((value) => value.toFixed(1))
            .join(", ")} | ${worst.toFixed(1)}${
            worst > memoryHigh ? " over" : ""
          } |\n`,
        );
      }
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

await main();
