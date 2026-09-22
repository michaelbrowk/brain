import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { canonicalMailLogRecords, parseMailLogLines } from "./mail-log-lines.mjs";

const root = process.cwd();
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const testTls = require("imapflow/test/fixtures/test-tls.js");
const artifactRoot = path.join(root, ".next", "standalone", "mail-service");
const work = await mkdtemp(path.join(tmpdir(), "brain-mail-artifact-smoke-"));
const projectionRoot = path.join(work, "runtime");
const preparedSocketPath = path.join(work, "prepared.sock");
const activeSocketPath = path.join(work, "brain-mail.sock");
const stateDirectory = path.join(work, "state");
const credentialsDirectory = path.join(work, "credentials");

let service;
let owner;
let projectedRuntimeRoot;
try {
  await mkdir(projectionRoot, { mode: 0o750 });
  const projection = await execFileAsync(
    "python3",
    [
      path.join(root, "scripts", "project-mail-runtime-for-smoke.py"),
      artifactRoot,
      projectionRoot,
    ],
    {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    },
  );
  assert.equal(projection.stderr, "");
  const runtimeRoot = projection.stdout.trim();
  assert.equal(runtimeRoot, path.join(await realpath(projectionRoot), "current"));
  projectedRuntimeRoot = runtimeRoot;
  const mainPath = path.join(runtimeRoot, "service", "main.js");
  const buildPath = path.join(runtimeRoot, "build.json");
  await mkdir(stateDirectory, { mode: 0o700 });
  await mkdir(credentialsDirectory, { mode: 0o700 });
  await writeFile(
    path.join(credentialsDirectory, "account-wrapping-key"),
    Buffer.alloc(32, 7),
    { mode: 0o600 },
  );
  const build = JSON.parse(await readFile(buildPath, "utf8"));
  assertBuild(build);
  await smokeProjectedImapAdapter(runtimeRoot);
  await assertRejectsMissingInheritedSocket(mainPath, runtimeRoot);

  owner = createNetServer();
  await listen(owner, preparedSocketPath);
  await chmod(preparedSocketPath, 0o660);
  await rename(preparedSocketPath, activeSocketPath);
  const inheritedFd = owner._handle?.fd;
  assert.equal(Number.isInteger(inheritedFd), true, "prepared Unix socket has no fd");
  const before = await stat(activeSocketPath);

  const childEnvironment = Object.freeze({
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    NODE_ENV: "production",
    LISTEN_FDS: "1",
    LISTEN_FDNAMES: "brain-mail",
    STATE_DIRECTORY: stateDirectory,
    CREDENTIALS_DIRECTORY: credentialsDirectory,
  });
  assert.deepEqual(Object.keys(childEnvironment).sort(), [
    "CREDENTIALS_DIRECTORY",
    "LISTEN_FDNAMES",
    "LISTEN_FDS",
    "NODE_ENV",
    "PATH",
    "STATE_DIRECTORY",
  ]);

  /*
    One more run of the same artifact, on its own socket, against the same
    state directory. The first run below keeps its own inline spawn because
    the socket-inode assertions around it are about that one inherited fd;
    everything after it is a restart, and a restart is what the stored pause
    has to survive.
  */
  const runProjectedService = async (socketPath, body) => {
    // Short names on purpose: a Unix socket path over 104 bytes is silently
    // truncated by bind(2), and the chmod that follows then fails on a path
    // nothing created.
    const prepared = path.join(path.dirname(socketPath), "prep.sock");
    owner = createNetServer();
    await listen(owner, prepared);
    await chmod(prepared, 0o660);
    await rename(prepared, socketPath);
    const fd = owner._handle?.fd;
    assert.equal(Number.isInteger(fd), true, "prepared Unix socket has no fd");
    service = spawn(
      "/bin/sh",
      [
        "-c",
        'LISTEN_PID=$$; export LISTEN_PID; exec "$@"',
        "brain-mail-smoke",
        process.execPath,
        "--disable-warning=ExperimentalWarning",
        mainPath,
      ],
      {
        cwd: runtimeRoot,
        env: childEnvironment,
        stdio: ["ignore", "pipe", "pipe", fd],
      },
    );
    const collected = collectOutput(service);
    const exited = waitForExit(service);
    await close(owner);
    try {
      await body(socketPath);
    } finally {
      service.kill("SIGTERM");
    }
    const result = await withTimeout(exited, 8_000, "mail service did not stop");
    return { result, logs: collected() };
  };

  service = spawn(
    "/bin/sh",
    [
      "-c",
      'LISTEN_PID=$$; export LISTEN_PID; exec "$@"',
      "brain-mail-smoke",
      process.execPath,
      "--disable-warning=ExperimentalWarning",
      mainPath,
    ],
    {
      cwd: runtimeRoot,
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe", inheritedFd],
    },
  );
  const output = collectOutput(service);
  const exit = waitForExit(service);
  await close(owner);

  const health = await pollJson(activeSocketPath, "GET", "/v1/health");
  assert.deepEqual(health, {
    status: 200,
    body: {
      apiVersion: 1,
      build,
      status: "ok",
      localSchemaVersion: 2,
      cacheSchemaVersion: 1,
      receiveReadiness: "not_configured",
      sendReadiness: "not_configured",
      activeAccounts: 0,
      queuedSubmissions: 0,
      lastSuccessfulSyncAgeMs: null,
      cachePressure: "normal",
      lastErrorCode: null,
    },
  });

  const reservations = await Promise.all([
    requestJson(activeSocketPath, "POST", "/v1/admission/reservations", {
      operationId: "artifact-smtp-a",
      delta: { concurrentSmtpSubmissions: 1 },
    }),
    requestJson(activeSocketPath, "POST", "/v1/admission/reservations", {
      operationId: "artifact-smtp-b",
      delta: { concurrentSmtpSubmissions: 1 },
    }),
  ]);
  assert.deepEqual(
    reservations.map(({ status }) => status).sort(),
    [201, 409],
  );
  const winner = reservations.find(({ status }) => status === 201);
  assert.match(
    winner?.body?.reservationId ?? "",
    /^reservation-r[0-9a-f]{32}$/,
  );
  const release = await requestJson(
    activeSocketPath,
    "DELETE",
    `/v1/admission/reservations/${winner.body.reservationId}`,
  );
  assert.equal(release.status, 204);

  // The pause, end to end against the real service over the real socket.
  const paused = await requestJson(activeSocketPath, "PATCH", "/v1/sync", {
    enabled: false,
  });
  assert.deepEqual(paused, { status: 200, body: { apiVersion: 1, paused: true } });
  const pausedHealth = await requestJson(activeSocketPath, "GET", "/v1/health");
  assert.equal(pausedHealth.body.status, "paused");
  // The readinesses do not move: a pause is not a verdict about them, and
  // `queuedSubmissions` stays 0 here because this smoke has no account.
  assert.equal(pausedHealth.body.sendReadiness, "not_configured");
  assert.equal(pausedHealth.body.queuedSubmissions, 0);
  const refusedSync = await requestJson(activeSocketPath, "POST", "/v1/sync", {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    maxItems: 5,
  });
  assert.equal(refusedSync.status, 409);
  assert.equal(refusedSync.body.error.code, "sync_paused");
  const resumed = await requestJson(activeSocketPath, "PATCH", "/v1/sync", {
    enabled: true,
  });
  assert.deepEqual(resumed, { status: 200, body: { apiVersion: 1, paused: false } });
  const resumedHealth = await requestJson(activeSocketPath, "GET", "/v1/health");
  assert.equal(resumedHealth.body.status, "ok");

  const afterRequests = await stat(activeSocketPath);
  assert.equal(afterRequests.ino, before.ino, "service replaced the inherited socket");
  assert.equal(afterRequests.mode & 0o777, 0o660, "service changed socket mode");

  service.kill("SIGTERM");
  const result = await withTimeout(exit, 8_000, "mail service did not stop");
  assert.deepEqual(result, { code: 0, signal: null });
  const logs = output();
  /*
    Not silence — one line, and the one this script asked for. The service records
    every answered failure now, refusals included, and the second reservation above
    is a refusal the smoke provokes on purpose: two callers race for a ceiling of
    one, and the loser is told so. An empty stderr would mean that record had gone
    missing. Naming the line keeps what the empty check was for — that a clean
    artifact run complains about nothing the script did not provoke itself.

    Every line has to be a record, and a line that is not fails by name with
    the line quoted. The records compare as a multiset: the two reservations
    race, and a second provoked refusal must not make this depend on which
    one the service answered first.
  */
  assert.deepEqual(
    canonicalMailLogRecords(parseMailLogLines(logs.stderr)),
    canonicalMailLogRecords([
      {
        event: "mail_request_failed",
        phase: "admission_reservation_post",
        errorCode: "capacity_exceeded",
      },
      {
        event: "mail_request_failed",
        phase: "sync_post",
        errorCode: "sync_paused",
      },
    ]),
  );
  assert.match(logs.stdout, /"event":"mail_service_started","phase":"running"/);
  assert.match(logs.stdout, /"event":"mail_service_stopping"/);

  const afterStop = await stat(activeSocketPath);
  assert.equal(afterStop.ino, before.ino, "service unlinked the inherited socket");

  /*
    COMES UP THE WAY IT WENT DOWN.

    The run above proved the row is written. This proves it is obeyed, which is
    a different claim and the one nothing else watches: `main.ts` has no test,
    and dropping the startup guard leaves every unit and the run above green
    while a paused service syncs and sends for an interval after each restart.
    `Restart=on-failure` makes a restart routine, so that interval is not rare.

    Two more processes against the same STATE_DIRECTORY: the first pauses and
    exits, the second has to come up paused without being told. Each gets its
    own socket, so the inode assertions above stay about the run above.
  */
  const restartSocketPath = path.join(work, "restart.sock");
  const paused2 = await runProjectedService(restartSocketPath, async (socket) => {
    const patched = await requestJson(socket, "PATCH", "/v1/sync", {
      enabled: false,
    });
    assert.deepEqual(patched, { status: 200, body: { apiVersion: 1, paused: true } });
  });
  assert.deepEqual(paused2.result, { code: 0, signal: null });
  assert.deepEqual(canonicalMailLogRecords(parseMailLogLines(paused2.logs.stderr)), []);

  const resumed2 = await runProjectedService(restartSocketPath, async (socket) => {
    const health = await pollJson(socket, "GET", "/v1/health");
    assert.equal(health.body.status, "paused", "restart did not honour the stored pause");
    const patched = await requestJson(socket, "PATCH", "/v1/sync", { enabled: true });
    assert.deepEqual(patched, { status: 200, body: { apiVersion: 1, paused: false } });
    const after = await requestJson(socket, "GET", "/v1/health");
    assert.equal(after.body.status, "ok");
  });
  assert.deepEqual(resumed2.result, { code: 0, signal: null });
  assert.deepEqual(canonicalMailLogRecords(parseMailLogLines(resumed2.logs.stderr)), []);
  /*
    The health above reads the stored flag, so on its own it cannot tell a
    service that honoured the flag from one that read it and started the
    workers anyway. This line can: the `phase` is the branch `main.ts` took.
  */
  assert.match(
    resumed2.logs.stdout,
    /"event":"mail_service_started","phase":"paused"/,
    "the restart read the pause but started its workers anyway",
  );
  assert.match(paused2.logs.stdout, /"event":"mail_service_started","phase":"running"/);

  process.stdout.write("brain-mail artifact smoke passed\n");
} finally {
  if (service?.exitCode === null && service.signalCode === null) {
    service.kill("SIGKILL");
  }
  if (owner?.listening) {
    await close(owner).catch(() => undefined);
  }
  if (projectedRuntimeRoot !== undefined) {
    for (const directory of [
      path.join(projectedRuntimeRoot, "providers", "imap"),
      path.join(projectedRuntimeRoot, "providers", "gmail"),
      path.join(projectedRuntimeRoot, "providers"),
      path.join(projectedRuntimeRoot, "service"),
      projectedRuntimeRoot,
    ]) {
      await chmod(directory, 0o700).catch(() => undefined);
    }
  }
  await rm(work, { recursive: true, force: true });
}

function assertBuild(value) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true);
  assert.deepEqual(Object.keys(value).sort(), ["builtAt", "commit"]);
  const development = value.commit === "dev" && value.builtAt === "dev";
  const release =
    /^[a-f0-9]{40}$/.test(value.commit) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.builtAt);
  assert.equal(development || release, true, "mail build identity is invalid");
}

async function smokeProjectedImapAdapter(runtimeRoot) {
  const commands = [];
  const server = createTlsServer(testTls, (socket) => {
    socket.once("error", () => undefined);
    socket.write("* OK fake IMAP ready\r\n");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      while (buffered.includes("\r\n")) {
        const separator = buffered.indexOf("\r\n");
        const line = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        if (!line) continue;
        commands.push(line);
        const [tag = "", command = ""] = line.split(/\s+/, 3);
        if (command.toUpperCase() === "CAPABILITY") {
          socket.write(
            `* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY completed\r\n`,
          );
        } else if (command.toUpperCase() === "LOGIN") {
          socket.write(`${tag} OK LOGIN completed\r\n`);
        } else if (command.toUpperCase() === "LIST") {
          socket.write(
            `* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`,
          );
        } else {
          socket.write(`${tag} BAD unsupported smoke command\r\n`);
        }
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(address !== null && typeof address !== "string", true);
  const caPath = path.join(work, "fake-imap-ca.pem");
  await writeFile(caPath, testTls.cert, { mode: 0o600 });
  let child;
  let childExit;
  try {
    child = spawn(
      process.execPath,
      [path.join(root, "scripts", "smoke-mail-imap-adapter.mjs")],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          NODE_ENV: "production",
          NODE_EXTRA_CA_CERTS: caPath,
          BRAIN_MAIL_ADAPTER_PATH: path.join(
            runtimeRoot,
            "service",
            "imapflow-adapter.js",
          ),
          BRAIN_MAIL_FAKE_IMAP_PORT: String(address.port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    childExit = waitForExit(child);
    const output = collectOutput(child);
    const result = await withTimeout(
      childExit,
      8_000,
      "projected fake IMAP smoke timed out",
    );
    assert.deepEqual(result, { code: 0, signal: null }, output().stderr);
    assert.equal(output().stderr, "");
    assert.equal(output().stdout, "brain-mail projected fake IMAP passed\n");
    assert.deepEqual(
      commands.map((line) => line.split(/\s+/, 3)[1]?.toUpperCase()),
      ["CAPABILITY", "LOGIN", "CAPABILITY", "LIST"],
    );
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await childExit?.catch(() => undefined);
    }
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

async function assertRejectsMissingInheritedSocket(entrypoint, runtimeRoot) {
  const child = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", entrypoint],
    {
      cwd: runtimeRoot,
      env: { NODE_ENV: "production" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const output = collectOutput(child);
  const result = await withTimeout(waitForExit(child), 3_000, "unsafe fallback stayed alive");
  assert.deepEqual(result, { code: 1, signal: null });
  assert.deepEqual(output(), {
    stdout:
      '{"event":"mail_service_start_failed","errorCode":"startup_failed"}\n',
    stderr: "",
  });
}

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function pollJson(socketPath, method, requestPath) {
  let lastError;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await requestJson(socketPath, method, requestPath);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError ?? new Error("mail service never became ready");
}

function requestJson(socketPath, method, requestPath, value) {
  const payload = value === undefined ? undefined : JSON.stringify(value);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path: requestPath,
        agent: false,
        headers: {
          Host: "brain-mail",
          Connection: "close",
          ...(payload === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(payload),
              }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: raw === "" ? null : JSON.parse(raw),
            });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.setTimeout(3_000, () => request.destroy(new Error("request timed out")));
    request.once("error", reject);
    request.end(payload);
  });
}

function collectOutput(child) {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  return () => ({ stdout, stderr });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
