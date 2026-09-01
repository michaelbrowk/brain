import { chmod, unlink } from "node:fs/promises";
import { createServer, Socket } from "node:net";

import { runMimeParserWorkerConnection } from "./mime-parser-runtime";

async function main(): Promise<void> {
  const testSocketPath = process.env.BRAIN_MAIL_MIME_TEST_SOCKET;
  if (testSocketPath !== undefined) {
    if (process.env.NODE_ENV !== "test" || !testSocketPath.startsWith("/tmp/")) {
      throw new Error("mail MIME test socket is invalid");
    }
    await unlink(testSocketPath).catch(() => undefined);
    const server = createServer((socket) => {
      server.close();
      void runMimeParserWorkerConnection(socket).finally(() => {
        void unlink(testSocketPath).catch(() => undefined);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(testSocketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(testSocketPath, 0o600);
    return;
  }

  const socket = new Socket({ fd: 0, readable: true, writable: true });
  await runMimeParserWorkerConnection(socket);
}

void main().catch(() => {
  process.exitCode = 1;
});
