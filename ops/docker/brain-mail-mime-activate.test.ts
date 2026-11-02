import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UnixSocketMailMimeParser } from "../../lib/mail/service/mime-parser-client";
import { serveMimeSocket } from "./brain-mail-mime-activate.mjs";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  // macOS Unix paths are limited to 104 bytes including the prepared suffix.
  const root = await mkdtemp("/tmp/brain-mime-container-");
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, socketPath: path.join(root, "mime.sock"), entrypoint: path.join(root, "worker.cjs") };
}

describe("Docker MIME socket activation", () => {
  it("hands each message to a fresh process and returns body plus attachment bytes", async () => {
    const f = await fixture();
    await build({ entryPoints: ["lib/mail/service/mime-parser-worker.ts"], outfile: f.entrypoint, bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "silent" });
    const stop = await serveMimeSocket(f); cleanups.push(stop);
    expect((await stat(f.socketPath)).mode & 0o777).toBe(0o600);
    const raw = Buffer.from([
      "From: fixture@example.test", 'Content-Type: multipart/mixed; boundary="test"', "",
      "--test", "Content-Type: text/plain; charset=utf-8", "", "Hello from the container", "--test",
      "Content-Type: text/plain", 'Content-Disposition: attachment; filename="hello.txt"', "Content-Transfer-Encoding: base64", "",
      Buffer.from("attachment evidence").toString("base64"), "--test--", "",
    ].join("\r\n"));
    const parser = new UnixSocketMailMimeParser({ socketPath: f.socketPath });
    for (let i = 0; i < 2; i++) {
      const result = await parser.parse({
        operationId: `docker-test-${i}`,
        rawMime: { sha256: createHash("sha256").update(raw).digest("hex"), bytes: raw.length },
        budget: { deadlineAt: Date.now() + 5_000, maxRawBytes: 1048576, maxDecodedBytes: 2097152, maxHeaderBytes: 16384, maxHtmlCharacters: 131072, maxTextCharacters: 131072, maxAddresses: 20, maxParts: 32, maxDepth: 8, maxDomNodes: 2000, maxDomAttributes: 4000, maxInlineImagePixels: 1000000, maxInlineImageFrames: 10, maxRemoteImages: 32 },
        rawMimeStream: (async function* () { yield raw; })(), signal: new AbortController().signal,
      });
      expect(result.kind).toBe("parsed");
      if (result.kind !== "parsed") return;
      expect(result.artifacts.text?.data.toString()).toContain("Hello from the container");
      expect(result.artifacts.attachments[0]?.blob.data.toString()).toBe("attachment evidence");
    }
  }, 15_000);

  it("does not pass service secrets to a worker and kills a worker past its deadline", async () => {
    const f = await fixture();
    await writeFile(f.entrypoint, `const s = new (require('node:net').Socket)({fd:0,readable:true,writable:true}); s.write(JSON.stringify({keys:Object.keys(process.env).sort(),args:process.execArgv})); setInterval(()=>{},1000);`);
    const stop = await serveMimeSocket({ ...f, timeoutMs: 500 }); cleanups.push(stop);
    const socket = createConnection(f.socketPath);
    const result = await new Promise<string>((resolve, reject) => {
      let out = "";
      socket.on("data", (bytes) => { out += bytes; }); socket.once("error", reject); socket.once("close", () => resolve(out));
    });
    const metadata = JSON.parse(result);
    // CoreFoundation injects this non-secret locale setting on macOS even
    // when spawn receives an otherwise empty environment. Linux adds none.
    expect(metadata.keys.filter((key: string) => key !== "__CF_USER_TEXT_ENCODING")).toEqual(["NODE_ENV"]);
    expect(metadata.args).toContain("--max-old-space-size=128");
  });

  it("admits only two simultaneous message workers", async () => {
    const f = await fixture();
    await writeFile(f.entrypoint, `const s = new (require('node:net').Socket)({fd:0,readable:true,writable:true}); s.write('ready'); setInterval(()=>{},1000);`);
    const stop = await serveMimeSocket(f); cleanups.push(stop);
    const held = [];
    for (let i = 0; i < 2; i++) {
      const socket = createConnection(f.socketPath); held.push(socket);
      await new Promise<void>((resolve, reject) => { socket.once("data", () => resolve()); socket.once("error", reject); });
    }
    const excess = createConnection(f.socketPath);
    let bytes = 0;
    excess.on("data", (data) => { bytes += data.length; });
    await new Promise<void>((resolve) => excess.once("close", () => resolve()));
    expect(bytes).toBe(0);
    for (const socket of held) socket.destroy();
  });
});
