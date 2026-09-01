#!/usr/bin/env node
// Boots the compose sample against one local image.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import bcrypt from "bcryptjs";

const execFileAsync = promisify(execFile);
const image = process.env.BRAIN_SMOKE_IMAGE;
const expectedCommit = process.env.BRAIN_SMOKE_COMMIT ?? "";
const port = process.env.BRAIN_SMOKE_PORT ?? "3023";
if (!image) throw new Error("BRAIN_SMOKE_IMAGE is required");
if (!/^[0-9a-f]{40}$/.test(expectedCommit)) throw new Error("BRAIN_SMOKE_COMMIT must be a 40-character commit");
const project = `brain-smoke-${process.pid}`;
const composeFile = path.join(process.cwd(), "ops", "docker", "docker-compose.smoke.yml");
const env = {
  ...process.env,
  BRAIN_SMOKE_IMAGE: image,
  BRAIN_SMOKE_PORT: port,
  BRAIN_SMOKE_PASSWORD_HASH: bcrypt.hashSync("smoke-password", 4),
};
const baseUrl = `http://127.0.0.1:${port}`;
const readiness = "a".repeat(64);

const compose = (...args) =>
  execFileAsync("docker", ["compose", "-p", project, "-f", composeFile, ...args], { env, maxBuffer: 16 * 1024 * 1024 });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectJson(url, init, description) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${description} returned ${response.status}`);
  return response.json();
}

try {
  // --entrypoint bypasses brain-entrypoint.sh, whose argument dispatch would
  // reject `sh` with exit 64. Both seeds run before the services boot.
  await compose("run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "mail", "-c",
    "head -c 32 /dev/urandom > /run/credentials/brain-mail/account-wrapping-key && chmod 0600 /run/credentials/brain-mail/account-wrapping-key");
  // Deep readiness requires the notes root to be a Git worktree with a
  // verifiable HEAD; seed the volume the way scripts/smoke-standalone.mjs does.
  await compose("run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "web", "-c",
    "git init -q -b main /opt/brain/notes && git -C /opt/brain/notes -c 'user.name=Brain Smoke' -c user.email=brain-smoke@example.invalid commit --allow-empty -q -m 'initialize smoke notes'");
  await compose("up", "-d");

  let health = null;
  for (let attempt = 0; attempt < 120 && !health; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health?ready=1`, { headers: { "x-brain-readiness": readiness } });
      const body = await response.json();
      if (response.ok && body.status === "ok") health = body;
    } catch {
      // Not up yet; poll below.
    }
    if (!health) await wait(500);
  }
  if (!health) throw new Error(`web never became ready\n${(await compose("logs", "web")).stdout}`);
  if (health.commit !== expectedCommit) throw new Error(`web reports commit ${health.commit}, expected ${expectedCommit}`);

  const unauthenticated = await fetch(`${baseUrl}/api/tree`);
  if (unauthenticated.status !== 401) throw new Error(`unauthenticated /api/tree returned ${unauthenticated.status}`);
  await unauthenticated.arrayBuffer();

  const auth = await fetch(`${baseUrl}/api/auth`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "smoke-password" }),
  });
  if (!auth.ok) throw new Error(`login returned ${auth.status}`);
  const cookie = /^brain_session=[^;]+/.exec(auth.headers.get("set-cookie") ?? "")?.[0];
  if (!cookie) throw new Error("login did not return a session cookie");
  await auth.arrayBuffer();
  const headers = { Cookie: cookie, "Content-Type": "application/json" };
  const created = await expectJson(`${baseUrl}/api/page`, { method: "POST", headers, body: JSON.stringify({ title: "Compose smoke", markdown: "first" }) }, "page create");
  const page = await expectJson(`${baseUrl}/api/page/${created.id}`, { headers }, "page read");
  if (page.markdown !== "first") throw new Error("page read returned the wrong body");
  const rendered = await fetch(`${baseUrl}/p/${created.id}`, { headers: { Cookie: cookie } });
  if (!rendered.ok || !(await rendered.text()).includes("Compose smoke")) throw new Error("page render failed");

  const mailProbe = [
    'const http=require("node:http");',
    'const req=http.request({socketPath:"/run/brain-mail/brain-mail.sock",path:"/v1/health",headers:{Host:"brain-mail"}},(res)=>{let body="";res.on("data",(c)=>body+=c);res.on("end",()=>{process.stdout.write(body);process.exit(res.statusCode===200?0:1);});});',
    'req.on("error",(e)=>{process.stderr.write(String(e));process.exit(1);});req.end();',
  ].join("");
  let mailHealth = null;
  for (let attempt = 0; attempt < 60 && !mailHealth; attempt += 1) {
    try {
      mailHealth = JSON.parse((await compose("exec", "-T", "web", "node", "-e", mailProbe)).stdout);
    } catch {
      await wait(500);
    }
  }
  if (!mailHealth) throw new Error(`mail never became healthy through the shared socket\n${(await compose("logs", "mail")).stdout}`);
  if (mailHealth.status !== "ok" || mailHealth.build?.commit !== expectedCommit) {
    throw new Error(`mail health is ${JSON.stringify(mailHealth)}`);
  }

  await compose("stop", "-t", "20", "web");
  const { stdout: webId } = await compose("ps", "-a", "-q", "web");
  const { stdout: exitCode } = await execFileAsync("docker", ["inspect", "--format", "{{.State.ExitCode}}", webId.trim()]);
  if (exitCode.trim() !== "143") throw new Error(`web exited with ${exitCode.trim()}, expected 143`);
  console.log("compose smoke passed");
} finally {
  await compose("down", "-v", "--remove-orphans").catch(() => undefined);
}
