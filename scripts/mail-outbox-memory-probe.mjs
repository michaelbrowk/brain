#!/usr/bin/env node
/**
 * What a send at a given attachment size costs the mail service in memory.
 *
 *   node scripts/mail-outbox-memory-probe.mjs --size 10
 *
 * Prints one peak per stage, per run, in MiB, against `MemoryHigh` from
 * `MAIL_PROCESS_LIMITS`. The figure is `process.resourceUsage().maxRSS`, a
 * high-water mark over a whole process, which is why each stage runs in its own
 * process: stages that never coexist in the service would otherwise add up into
 * a peak that never happens.
 *
 * The three stages are the three the service actually has:
 *
 *   build    the request body off the socket, decoded, parsed, validated, and
 *            the MIME message written. `POST /v1/send` up to the store.
 *   enqueue  the same request carrying on into `store.enqueue`: the row's JSON,
 *            the message into its BLOB column, the insert.
 *   read     the later turn that reads the row back to deliver it, in a fresh
 *            process, because it never overlaps the build.
 *
 * The request body is written by a separate step, so the cost of making
 * megabytes of base64 never lands on the service's mark. The payload is
 * low-entropy on purpose: it is the size that is being measured, not zlib.
 *
 * No network, no server. It needs the repository's dependencies installed,
 * because it bundles the service's own modules with esbuild and measures those
 * rather than a copy of them.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

import { build } from "esbuild";

const ENTRY = `
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import {
  createMailSendSubmissionProposal,
  runExclusiveOutboundBuild,
  validateMailSendInput,
} from "./lib/mail/service/outbound";
import { SqliteMailSendStore } from "./lib/mail/service/outbound-store";
import { MAIL_PROCESS_LIMITS } from "./lib/mail/security";

const ACCOUNT = Object.freeze({
  accountId: "account-a" + "1".repeat(32),
  providerKind: "gmail",
  emailAddress: "sender@example.test",
  status: "connected",
});
const OPERATION_ID = "send-00000000-0000-4000-8000-000000000001";
const CREATED_AT = 1_800_000_000_000;

function report() {
  process.stdout.write(
    "maxRSS " + process.resourceUsage().maxRSS / 1024 + "\\n",
  );
}

/** The client's side, so its own copies never land on the service's mark. */
function prepare(bodyPath, bytes) {
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
      text: "One line of body beside the file.\\n",
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
async function buildProposal(bodyPath) {
  const body = readFileSync(bodyPath);
  const input = validateMailSendInput(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
  );
  return runExclusiveOutboundBuild(() =>
    createMailSendSubmissionProposal({
      account: ACCOUNT,
      input,
      reply: null,
      operationId: OPERATION_ID,
      createdAt: CREATED_AT,
    }),
  );
}

async function openStore(cacheRoot) {
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
  const store = new SqliteMailSendStore({ cacheRoot, now: () => CREATED_AT });
  await store.initialize();
  return store;
}

const [stage, bodyPath, cacheRoot, sizeBytes] = process.argv.slice(2);

if (stage === "limits") {
  process.stdout.write(
    "memoryHigh " + MAIL_PROCESS_LIMITS.memoryHighBytes / (1024 * 1024) + "\\n",
  );
} else if (stage === "prepare") {
  prepare(bodyPath, Number(sizeBytes));
} else if (stage === "build") {
  await buildProposal(bodyPath);
  report();
} else if (stage === "enqueue") {
  const proposal = await buildProposal(bodyPath);
  const store = await openStore(cacheRoot);
  await store.enqueue(proposal);
  await store.close();
  report();
} else if (stage === "read") {
  const store = await openStore(cacheRoot);
  const stored = await store.readByOperationId(OPERATION_ID);
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
} else {
  throw new Error("unknown stage: " + stage);
}
`;

const STAGES = ["build", "enqueue", "read"];

function parseArguments(argv) {
  const options = { sizes: [], runs: 3 };
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
    } else if (flag === "--runs") {
      options.runs = Number(value);
      if (!Number.isSafeInteger(options.runs) || options.runs < 1) {
        throw new Error("--runs takes a whole number of runs");
      }
      index += 1;
    } else {
      throw new Error(`usage: mail-outbox-memory-probe.mjs --size 10 [--runs 3]`);
    }
  }
  if (options.sizes.length === 0) options.sizes.push(10);
  return options;
}

function runStage(bundle, stage, bodyPath, cacheRoot, sizeBytes) {
  const result = spawnSync(
    process.execPath,
    [bundle, stage, bodyPath, cacheRoot, String(sizeBytes)],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    throw new Error(`stage ${stage} exited ${result.status}`);
  }
  if (stage === "prepare") return 0;
  const field = stage === "limits" ? "memoryHigh" : "maxRSS";
  const match = new RegExp(`^${field} (\\d+(?:\\.\\d+)?)$`, "m").exec(
    result.stdout,
  );
  if (!match) throw new Error(`stage ${stage} printed no figure`);
  return Number(match[1]);
}

/** A bare `node` on this machine, so a peak can be read against something. */
function baseline() {
  const result = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(String(process.resourceUsage().maxRSS / 1024))"],
    { encoding: "utf8" },
  );
  return Number(result.stdout);
}

const options = parseArguments(process.argv.slice(2));
const root = process.cwd();
const workspace = await mkdtemp(path.join(tmpdir(), "brain-outbox-probe-"));
const bundle = path.join(workspace, "probe.mjs");

try {
  const bundled = await build({
    stdin: { contents: ENTRY, resolveDir: root, sourcefile: "probe.ts", loader: "ts" },
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    write: false,
    logLevel: "warning",
  });
  await writeFile(bundle, bundled.outputFiles[0].text, { mode: 0o600 });

  const memoryHigh = runStage(bundle, "limits", "", "", 0);

  process.stdout.write(
    `node ${process.version} on ${process.platform}, bare-node baseline ` +
      `${baseline().toFixed(1)} MiB, MemoryHigh ${memoryHigh} MiB\n\n`,
  );
  process.stdout.write("| attachment | stage | runs (MiB) | worst |\n");
  process.stdout.write("| ---: | --- | --- | ---: |\n");

  for (const mib of options.sizes) {
    const bytes = Math.round(mib * 1024 * 1024);
    const peaks = new Map(STAGES.map((stage) => [stage, []]));
    for (let run = 0; run < options.runs; run += 1) {
      const runRoot = path.join(workspace, `run-${mib}-${run}`);
      const bodyPath = path.join(workspace, `body-${mib}-${run}.json`);
      runStage(bundle, "prepare", bodyPath, runRoot, bytes);
      for (const stage of STAGES) {
        peaks.get(stage).push(runStage(bundle, stage, bodyPath, runRoot, bytes));
      }
      await rm(bodyPath, { force: true });
      await rm(runRoot, { recursive: true, force: true });
    }
    for (const stage of STAGES) {
      const runs = peaks.get(stage);
      const worst = Math.max(...runs);
      process.stdout.write(
        `| ${mib} MiB | ${stage} | ${runs.map((value) => value.toFixed(1)).join(", ")} | ` +
          `${worst.toFixed(1)}${worst > memoryHigh ? " over" : ""} |\n`,
      );
    }
  }
} finally {
  await rm(workspace, { recursive: true, force: true });
}
