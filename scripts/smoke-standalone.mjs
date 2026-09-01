import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";

const execFileAsync = promisify(execFile);

const root = process.cwd();
const standalone = path.join(root, ".next", "standalone");
const staticTarget = path.join(standalone, ".next", "static");
const publicTarget = path.join(standalone, "public");
const shutdownPreloadTarget = path.join(
  standalone,
  "brain-shutdown-preload.mjs",
);
const nextServerTarget = path.join(standalone, "brain-next-server.js");
const serverTarget = path.join(standalone, "server.js");
const port = Number.parseInt(
  process.env.BRAIN_STANDALONE_SMOKE_PORT ?? "3022",
  10,
);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("BRAIN_STANDALONE_SMOKE_PORT must be a valid unprivileged port");
}
const baseUrl = `http://127.0.0.1:${port}`;

async function inspectArtifact(rootPath) {
  let bytes = 0;
  const jsdomApis = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile()) {
        bytes += (await lstat(entryPath)).size;
        if (entryPath.endsWith(`${path.sep}jsdom${path.sep}lib${path.sep}api.js`)) {
          jsdomApis.push(entryPath);
        }
      }
    }
  }
  return { bytes, jsdomApis };
}

await rm(staticTarget, { recursive: true, force: true });
await rm(publicTarget, { recursive: true, force: true });
await mkdir(path.dirname(staticTarget), { recursive: true });
await cp(path.join(root, ".next", "static"), staticTarget, { recursive: true });
await cp(path.join(root, "public"), publicTarget, { recursive: true });
await cp(
  path.join(root, "ops", "brain-shutdown-preload.mjs"),
  shutdownPreloadTarget,
);
try {
  await access(nextServerTarget);
} catch {
  await rename(serverTarget, nextServerTarget);
}
await cp(path.join(root, "ops", "brain-server.cjs"), serverTarget);

const artifact = await inspectArtifact(standalone);
if (artifact.bytes > 120 * 1024 * 1024) {
  throw new Error(
    `standalone artifact is unexpectedly large: ${Math.ceil(artifact.bytes / 1024 / 1024)} MiB`,
  );
}
if (artifact.jsdomApis.length !== 1) {
  throw new Error(
    `standalone artifact must contain exactly one jsdom runtime, found ${artifact.jsdomApis.length}`,
  );
}
const requireFromJsdom = createRequire(artifact.jsdomApis[0]);
for (const dependency of [
  "@asamuzakjp/css-color",
  "@csstools/css-syntax-patches-for-csstree",
  "css-tree",
]) {
  try {
    requireFromJsdom.resolve(dependency);
    requireFromJsdom(dependency);
  } catch (cause) {
    throw new Error(
      `standalone-jsdom dependency ${JSON.stringify(dependency)} is unavailable`,
      { cause },
    );
  }
}

const notesRoot = await mkdtemp(path.join(tmpdir(), "brain-standalone-notes-"));
const oauthStateRoot = await mkdtemp(
  path.join(tmpdir(), "brain-standalone-oauth-"),
);

await execFileAsync("git", ["init", "-q", "-b", "main"], {
  cwd: notesRoot,
});
await execFileAsync(
  "git",
  [
    "-c",
    "user.name=Brain Smoke",
    "-c",
    "user.email=brain-smoke@example.invalid",
    "commit",
    "--allow-empty",
    "-q",
    "-m",
    "initialize smoke notes",
  ],
  { cwd: notesRoot },
);

const childEnv = {
  ...process.env,
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  NOTES_ROOT: notesRoot,
  AUTH_SECRET: "brain-standalone-smoke-secret-not-for-production",
  AUTH_PASSWORD_HASH: bcrypt.hashSync("smoke-password", 4),
  MCP_TOKEN: "brain-standalone-smoke-mcp-token",
  BRAIN_READINESS_TOKEN: "a".repeat(64),
  BRAIN_EDGE_RATE_SECRET: "b".repeat(64),
  BRAIN_OAUTH_STATE_DIR: oauthStateRoot,
  OPENROUTER_API_KEY: "",
  GIT_AUTHOR_NAME: "Brain Smoke",
  GIT_AUTHOR_EMAIL: "brain-smoke@example.invalid",
  GIT_COMMITTER_NAME: "Brain Smoke",
  GIT_COMMITTER_EMAIL: "brain-smoke@example.invalid",
};

let child = null;
let output = "";
let childMessages = [];
const startChild = ({ startupBarrierToken = "" } = {}) => {
  if (child && child.exitCode === null && child.signalCode === null) {
    throw new Error("standalone server is already running");
  }

  output = "";
  childMessages = [];
  child = spawn(process.execPath, ["server.js"], {
    cwd: standalone,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...childEnv,
      ...(startupBarrierToken
        ? { BRAIN_STANDALONE_STARTUP_BARRIER_TOKEN: startupBarrierToken }
        : {}),
    },
  });

  child.on("message", (message) => childMessages.push(message));

  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = `${output}${chunk.toString()}`.slice(-16_000);
    });
  }

  return child;
};

const childIsRunning = () =>
  child !== null && child.exitCode === null && child.signalCode === null;

const waitForChildExit = (target, timeoutMs) => {
  if (target.exitCode !== null || target.signalCode !== null) {
    return Promise.resolve({ code: target.exitCode, signal: target.signalCode });
  }

  return new Promise((resolve, reject) => {
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(async () => {
      target.off("exit", onExit);
      let sockets = "";
      try {
        ({ stdout: sockets } = await execFileAsync("lsof", [
          "-nP",
          "-a",
          "-p",
          String(target.pid),
          "-iTCP",
        ]));
      } catch {
        sockets = "socket diagnostics unavailable";
      }
      reject(
        new Error(
          `standalone server did not exit within ${timeoutMs}ms\n${output}\n${sockets}`,
        ),
      );
    }, timeoutMs);
    target.once("exit", onExit);
  });
};

const waitForChildMessage = (target, predicate, timeoutMs, description) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.off("message", onMessage);
      target.off("exit", onExit);
    };
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `standalone exited before ${description}: code=${code} signal=${signal}\n${output}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${description} timed out\n${output}`));
    }, timeoutMs);
    target.on("message", onMessage);
    target.once("exit", onExit);
  });

const sendChildMessage = (target, message) =>
  new Promise((resolve, reject) => {
    if (!target.connected) {
      reject(new Error("standalone IPC channel closed before barrier release"));
      return;
    }
    target.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const waitForOutput = (target, marker, timeoutMs) =>
  new Promise((resolve, reject) => {
    if (output.includes(marker)) {
      resolve();
      return;
    }

    const streams = [target.stdout, target.stderr];
    const cleanup = () => {
      clearTimeout(timer);
      for (const stream of streams) stream.off("data", onData);
      target.off("exit", onExit);
    };
    const onData = () => {
      if (!output.includes(marker)) return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `standalone exited before log marker ${JSON.stringify(marker)}: code=${code} signal=${signal}\n${output}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `standalone omitted log marker ${JSON.stringify(marker)}\n${output}`,
        ),
      );
    }, timeoutMs);
    for (const stream of streams) stream.on("data", onData);
    target.once("exit", onExit);
  });

const waitForHealthy = async (target) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (target.exitCode !== null || target.signalCode !== null) {
      throw new Error(`standalone server exited early\n${output}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health?ready=1`, {
        headers: { "x-brain-readiness": "a".repeat(64) },
      });
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok") return;
      } else {
        await response.arrayBuffer();
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`standalone health timed out\n${output}`);
};

const withTimeout = (promise, timeoutMs, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
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

const readSseEvent = async (reader, timeoutMs) => {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = "";

  while (!text.includes("\n\n")) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("standalone SSE ready event timed out");
    const result = await withTimeout(
      reader.read(),
      remaining,
      "standalone SSE ready event timed out",
    );
    if (result.done) throw new Error("standalone SSE closed before its ready event");
    text += decoder.decode(result.value, { stream: true });
  }

  return text;
};

const waitForSseClose = async (reader, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("standalone SSE did not drain on SIGTERM");
    const result = await withTimeout(
      reader.read(),
      remaining,
      "standalone SSE did not drain on SIGTERM",
    );
    if (result.done) return;
  }
};

const openAuthenticatedEventStream = async (cookie) => {
  const response = await fetch(`${baseUrl}/api/events`, {
    headers: { Cookie: cookie },
  });
  if (!response.ok) {
    throw new Error(`authenticated SSE returned ${response.status}`);
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("authenticated SSE returned the wrong content type");
  }
  if (!response.body) throw new Error("authenticated SSE returned no body");
  const reader = response.body.getReader();
  const readyEvent = await readSseEvent(reader, 2_000);
  if (!readyEvent.includes("event: ready")) {
    throw new Error("authenticated SSE omitted its ready event");
  }
  return reader;
};

const assertGracefulExit = (exit, shutdownMs, label) => {
  if (exit.code !== 143 || exit.signal !== null) {
    throw new Error(
      `${label} returned code=${exit.code} signal=${exit.signal}\n${output}`,
    );
  }
  if (shutdownMs >= 3_000) {
    throw new Error(`${label} took ${Math.round(shutdownMs)}ms\n${output}`);
  }
};

const startPartialAuthenticatedPut = async ({ cookie, id, payload }) => {
  const body = Buffer.from(JSON.stringify(payload));
  const splitAt = Math.max(1, Math.floor(body.length / 2));
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.setNoDelay(true);

  let transcript = "";
  const responsePromise = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      transcript += chunk.toString("utf8");
    });
    socket.once("end", () => resolve(transcript));
    socket.once("error", reject);
  });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  socket.write(
    [
      `PUT /api/page/${encodeURIComponent(id)} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Cookie: ${cookie}`,
      "Content-Type: application/json",
      `Content-Length: ${body.length}`,
      "Expect: 100-continue",
      "Connection: close",
      "",
      "",
    ].join("\r\n"),
  );

  const deadline = Date.now() + 2_000;
  while (!transcript.includes("HTTP/1.1 100 Continue")) {
    if (Date.now() >= deadline) {
      socket.destroy();
      throw new Error(`partial PUT did not receive 100 Continue\n${transcript}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  socket.write(body.subarray(0, splitAt));
  return {
    // Content-Length marks the end of the request. Keep the client side open
    // for the final response; Connection: close makes the server end it.
    finish: () => socket.write(body.subarray(splitAt)),
    responsePromise,
  };
};

const stop = async () => {
  if (childIsRunning()) {
    child.kill("SIGTERM");
    try {
      await waitForChildExit(child, 3_000);
    } catch {
      if (childIsRunning()) child.kill("SIGKILL");
      await waitForChildExit(child, 1_000);
    }
  }
  await Promise.all(
    [notesRoot, oauthStateRoot].map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      }),
    ),
  );
};

try {
  let current = startChild();
  await waitForHealthy(current);

  const login = await fetch(`${baseUrl}/login`);
  if (!login.ok) throw new Error(`standalone login returned ${login.status}`);
  await login.arrayBuffer();

  // The proxy matcher is the only human-auth boundary for the notes API —
  // routes like /api/tree carry no session check of their own. These are the
  // only assertions anywhere that prove the packaged artifact actually ships
  // and executes that boundary (audit 2026-08-19: the lone 401 check below
  // hits /api/mcp, a path the proxy deliberately passes through).
  const unauthTree = await fetch(`${baseUrl}/api/tree`);
  if (unauthTree.status !== 401) {
    throw new Error(
      `unauthenticated /api/tree returned ${unauthTree.status}, expected 401`,
    );
  }
  await unauthTree.arrayBuffer();
  const unauthSettings = await fetch(`${baseUrl}/api/settings/mcp`);
  if (unauthSettings.status !== 401) {
    throw new Error(
      `unauthenticated /api/settings/mcp returned ${unauthSettings.status}, expected 401`,
    );
  }
  await unauthSettings.arrayBuffer();
  const unauthPage = await fetch(`${baseUrl}/p/smoke-private-page`, {
    redirect: "manual",
  });
  if (unauthPage.status !== 307 && unauthPage.status !== 308) {
    throw new Error(
      `unauthenticated /p/<id> returned ${unauthPage.status}, expected a redirect to /login`,
    );
  }
  const unauthLocation = unauthPage.headers.get("location") ?? "";
  if (!unauthLocation.includes("/login")) {
    throw new Error(
      `unauthenticated /p/<id> redirected to ${unauthLocation}, expected /login`,
    );
  }
  await unauthPage.arrayBuffer();

  const auth = await fetch(`${baseUrl}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "smoke-password" }),
  });
  if (!auth.ok) throw new Error(`standalone auth returned ${auth.status}`);
  const setCookie = auth.headers.get("set-cookie") ?? "";
  const cookie = /^brain_session=[^;]+/.exec(setCookie)?.[0];
  if (!cookie) throw new Error("standalone auth did not return a session cookie");
  await auth.arrayBuffer();

  const bootstrapExitPromise = waitForChildExit(current, 3_000);
  if (!current.kill("SIGTERM")) {
    throw new Error("could not stop standalone auth bootstrap");
  }
  assertGracefulExit(
    await bootstrapExitPromise,
    0,
    "standalone auth bootstrap shutdown",
  );

  const startupBarrierToken = randomUUID();
  current = startChild({ startupBarrierToken });
  await waitForChildMessage(
    current,
    (message) =>
      message?.type === "brain-startup-latch-blocked" &&
      message?.token === startupBarrierToken,
    2_000,
    "pre-app shutdown latch barrier",
  );

  const acceptedRequest = waitForChildMessage(
    current,
    (message) =>
      message?.type === "brain-startup-request-accepted" &&
      message?.token === startupBarrierToken,
    2_000,
    "accepted pre-app SSE request",
  );
  const delayedEventsPromise = fetch(`${baseUrl}/api/events`, {
    headers: {
      Cookie: cookie,
      "x-brain-standalone-startup-barrier": startupBarrierToken,
    },
  });
  await acceptedRequest;

  const earlyExitPromise = waitForChildExit(current, 3_000);
  const capturedSignal = waitForChildMessage(
    current,
    (message) => message?.type === "brain-startup-signal-captured",
    2_000,
    "startup SIGTERM capture",
  );
  const earlyShutdownMarker = waitForOutput(
    current,
    "Brain SSE shutdown started; closed 0 active stream(s)",
    2_000,
  );
  const earlyShutdownStarted = performance.now();
  if (!current.kill("SIGTERM")) {
    throw new Error("could not send early SIGTERM to standalone server");
  }
  const captured = await capturedSignal;
  if (
    captured?.signal !== "SIGTERM" ||
    captured?.deliveredToNext !== true
  ) {
    throw new Error(
      `startup SIGTERM did not record delivery to Next: ${JSON.stringify(captured)}`,
    );
  }
  await sendChildMessage(current, {
    type: "brain-startup-latch-release",
    token: startupBarrierToken,
  });
  await earlyShutdownMarker;

  const delayedEvents = await withTimeout(
    delayedEventsPromise,
    2_000,
    "accepted SSE did not finish after the shutdown latch",
  );
  if (!delayedEvents.ok || !delayedEvents.body) {
    throw new Error(
      `accepted SSE returned ${delayedEvents.status} without a body after SIGTERM`,
    );
  }
  const delayedEventsReader = delayedEvents.body.getReader();
  const delayedReady = await readSseEvent(delayedEventsReader, 2_000);
  if (!delayedReady.includes("event: ready")) {
    throw new Error("accepted SSE omitted ready after its registration barrier");
  }
  await waitForSseClose(delayedEventsReader, 2_000);
  const earlyExit = await earlyExitPromise;
  const earlyShutdownMs = performance.now() - earlyShutdownStarted;
  assertGracefulExit(
    earlyExit,
    earlyShutdownMs,
    "standalone pre-app-latch graceful shutdown",
  );
  if (
    childMessages.some(
      (message) => message?.type === "brain-startup-signal-replayed",
    )
  ) {
    throw new Error("startup SIGTERM was replayed after Next already received it");
  }
  const earlyShutdownLogs = output.match(
    /Brain SSE shutdown started; closed 0 active stream\(s\)/g,
  );
  if (earlyShutdownLogs?.length !== 1) {
    throw new Error(
      `startup shutdown latch logged ${earlyShutdownLogs?.length ?? 0} times\n${output}`,
    );
  }

  current = startChild();
  await waitForHealthy(current);

  const authenticatedJson = async (url, init = {}) => {
    const response = await fetch(`${baseUrl}${url}`, {
      ...init,
      headers: {
        Cookie: cookie,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${url} returned ${response.status}`);
    }
    return response.json();
  };

  const initialMarkdown = 'first\n\n<img src="x" onerror="alert(1)">';
  const created = await authenticatedJson("/api/page", {
    method: "POST",
    body: JSON.stringify({
      title: "Standalone smoke",
      markdown: initialMarkdown,
    }),
  });
  if (typeof created.id !== "string") {
    throw new Error("standalone create did not return a page id");
  }
  const page = await authenticatedJson(`/api/page/${created.id}`);
  if (page.markdown !== initialMarkdown || typeof page.rev !== "string") {
    throw new Error("standalone page read returned an invalid body or revision");
  }
  // Exercise a cold RSC page render, not only API handlers. The app shell
  // imports the Markdown sanitizer, whose server path needs the complete jsdom
  // package in the immutable standalone artifact.
  const renderedPage = await fetch(
    `${baseUrl}/p/${created.id}`,
    { headers: { Cookie: cookie } },
  );
  if (!renderedPage.ok) {
    throw new Error(
      `standalone page render returned ${renderedPage.status}\n${output}`,
    );
  }
  const renderedPageBody = await renderedPage.text();
  if (!renderedPageBody.includes("Standalone smoke")) {
    throw new Error(
      `standalone page render omitted the expected page marker\n${output}`,
    );
  }
  let shareMayBeEnabled = false;
  let written;
  try {
    const disclosure = await authenticatedJson(
      `/api/page/${created.id}/share`,
    );
    if (
      disclosure.rootId !== created.id ||
      disclosure.descendantCount !== 0 ||
      !/^[0-9a-f]{64}$/.test(disclosure.scopeToken) ||
      disclosure.public !== false
    ) {
      throw new Error("standalone share disclosure returned an invalid scope");
    }
    // From this point the enable request may commit even if its HTTP response
    // is lost or cannot be parsed, so cleanup must already be armed.
    shareMayBeEnabled = true;
    const enabledShare = await authenticatedJson(
      `/api/page/${created.id}/share`,
      {
        method: "POST",
        body: JSON.stringify({
          enabled: true,
          expectedScopeToken: disclosure.scopeToken,
          password: null,
          expiresAt: null,
        }),
      },
    );
    const enabledReadBack = await authenticatedJson(
      `/api/page/${created.id}/share`,
    );
    if (
      enabledShare.rootId !== created.id ||
      enabledShare.public !== true ||
      enabledShare.shareLocked !== false ||
      enabledShare.shareExpiresAt !== null ||
      enabledReadBack.public !== true ||
      enabledReadBack.scopeToken !== enabledShare.scopeToken ||
      enabledReadBack.shareVersion !== enabledShare.shareVersion
    ) {
      throw new Error("standalone share enable did not survive durable read-back");
    }

    const sharedPage = await fetch(`${baseUrl}/share/${created.id}`);
    if (!sharedPage.ok) {
      throw new Error(
        `standalone shared-page render returned ${sharedPage.status}\n${output}`,
      );
    }
    const sharedPageBody = await sharedPage.text();
    if (
      !sharedPageBody.includes("Standalone smoke") ||
      !sharedPageBody.includes("first")
    ) {
      throw new Error(
        `standalone shared-page render omitted expected content\n${output}`,
      );
    }
    if (
      sharedPageBody.includes("onerror") ||
      sharedPageBody.includes("alert(1)")
    ) {
      throw new Error(
        "standalone shared-page render did not sanitize active HTML",
      );
    }
    written = await authenticatedJson(`/api/page/${created.id}`, {
      method: "PUT",
      // Deliberately keep the pre-share revision. The unchanged historical body
      // proves this is a metadata-only conflict and exercises the real merge path.
      body: JSON.stringify({
        markdown: "second",
        rev: page.rev,
        baseMarkdown: initialMarkdown,
      }),
    });
    if (
      written.markdown !== "second" ||
      typeof written.rev !== "string" ||
      written.rev === page.rev ||
      written.meta?.public !== true
    ) {
      throw new Error(
        "standalone revisioned metadata-only write did not persist safely",
      );
    }
  } finally {
    if (shareMayBeEnabled) {
      const revokedShare = await authenticatedJson(
        `/api/page/${created.id}/share`,
        {
          method: "POST",
          body: JSON.stringify({ enabled: false }),
        },
      );
      const revokedReadBack = await authenticatedJson(
        `/api/page/${created.id}/share`,
      );
      if (
        revokedShare.rootId !== created.id ||
        revokedShare.public !== false ||
        revokedReadBack.public !== false ||
        revokedReadBack.scopeToken !== revokedShare.scopeToken ||
        revokedReadBack.shareVersion !== revokedShare.shareVersion
      ) {
        throw new Error(
          "standalone share revoke did not survive durable read-back",
        );
      }
    }
  }
  if (!written) {
    throw new Error("standalone revisioned write did not complete");
  }

  const mcp = await fetch(`${baseUrl}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (mcp.status !== 401) {
    throw new Error(`unauthenticated MCP returned ${mcp.status}`);
  }
  await mcp.arrayBuffer();

  const eventReaders = await Promise.all(
    Array.from({ length: 20 }, () => openAuthenticatedEventStream(cookie)),
  );
  const persistedMarkdown = `shutdown-persisted-${randomUUID()}`;
  const partialPut = await startPartialAuthenticatedPut({
    cookie,
    id: created.id,
    payload: {
      markdown: persistedMarkdown,
      rev: written.rev,
      baseMarkdown: "second",
    },
  });

  const exitPromise = waitForChildExit(current, 3_000);
  const shutdownMarker = waitForOutput(
    current,
    "Brain SSE shutdown started; closed 20 active stream(s)",
    2_000,
  );
  const sseClosePromises = eventReaders.map((reader) =>
    waitForSseClose(reader, 3_000),
  );
  const shutdownStarted = performance.now();
  if (!current.kill("SIGTERM")) {
    throw new Error("could not send SIGTERM to standalone server");
  }
  await shutdownMarker;
  partialPut.finish();

  const [rawPutResponse, exit] = await Promise.all([
    withTimeout(
      partialPut.responsePromise,
      3_000,
      "partial PUT did not finish after SIGTERM",
    ),
    exitPromise,
    ...sseClosePromises,
  ]);
  const shutdownMs = performance.now() - shutdownStarted;
  if (!rawPutResponse.includes("HTTP/1.1 100 Continue")) {
    throw new Error(`partial PUT omitted 100 Continue\n${rawPutResponse}`);
  }
  if (!/HTTP\/1\.1 200(?: OK)?\r\n/.test(rawPutResponse)) {
    throw new Error(
      `partial PUT did not finish with HTTP 200 after SIGTERM\n${rawPutResponse}\n${output}`,
    );
  }
  assertGracefulExit(exit, shutdownMs, "standalone save-safe graceful shutdown");

  let persistedMatches = "";
  try {
    ({ stdout: persistedMatches } = await execFileAsync("rg", [
      "--fixed-strings",
      "--files-with-matches",
      persistedMarkdown,
      notesRoot,
    ]));
  } catch (error) {
    throw new Error(
      `partial PUT returned 200 but its Markdown was not persisted\n${error}`,
    );
  }
  if (!persistedMatches.trim()) {
    throw new Error("partial PUT returned 200 without a persisted notes file");
  }

  console.log(
    `standalone smoke passed; late SSE drained in ${Math.round(earlyShutdownMs)}ms; 20 SSE streams and an in-flight write drained in ${Math.round(shutdownMs)}ms`,
  );
} finally {
  await stop();
}
