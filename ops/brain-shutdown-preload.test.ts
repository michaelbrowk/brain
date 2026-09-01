import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const preload = path.join(process.cwd(), "ops", "brain-shutdown-preload.mjs");

function waitForOutput(child: ChildProcess, marker: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`missing ${marker}: ${output}`));
    }, 2_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (!output.includes(marker)) return;
      cleanup();
      resolve(output);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
  });
}

function waitForMessage(child: ChildProcess, type: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`missing IPC message ${type}`)),
      2_000,
    );
    const onMessage = (message: unknown) => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== type
      ) {
        return;
      }
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve(message);
    };
    child.on("message", onMessage);
  });
}

function waitForExit(
  child: ChildProcess,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

function spawnFixture(source: string): ChildProcess {
  const child = spawn(
    process.execPath,
    [`--import=${preload}`, "--input-type=module", "--eval", source],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  children.add(child);
  return child;
}

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      if (child.exitCode === null && child.signalCode === null) {
        await waitForExit(child);
      }
      children.delete(child);
    }),
  );
});

describe("Brain startup shutdown preload", () => {
  it("latches a pre-Next SIGTERM, then replays it exactly once", async () => {
    const fixture = `
      const state = globalThis[Symbol.for("brain.startup-shutdown-state")];
      let appSignals = 0;
      let nextSignals = 0;
      let shutdownStarts = 0;
      const beginShutdown = () => {
        if (shutdownStarts > 0) return;
        shutdownStarts += 1;
        console.info("Brain SSE shutdown started; closed 0 active stream(s)");
      };
      const nextCleanup = (signal) => {
        nextSignals += 1;
        if (signal !== "SIGTERM") return;
        setImmediate(() => {
          process.stdout.write(
            \`summary next=\${nextSignals} app=\${appSignals} begin=\${shutdownStarts} replayed=\${state.replayed}\\n\`,
          );
          process.exit(143);
        });
      };
      process.stdout.write("fixture-ready\\n");
      process.on("message", (message) => {
        if (message !== "activate") return;
        process.on("SIGINT", nextCleanup);
        process.on("SIGTERM", nextCleanup);
        const activated = state.activate(beginShutdown, () => {
          process.on("SIGINT", () => { appSignals += 1; beginShutdown(); });
          process.on("SIGTERM", () => { appSignals += 1; beginShutdown(); });
        });
        if (activated !== true) process.exit(12);
      });
      setInterval(() => {}, 1_000);
    `;
    const child = spawnFixture(fixture);

    await waitForOutput(child, "fixture-ready");
    const captured = waitForMessage(child, "brain-startup-signal-captured");
    const replayed = waitForMessage(child, "brain-startup-signal-replayed");
    const summary = waitForOutput(
      child,
      "summary next=1 app=1 begin=1 replayed=true",
    );
    const exit = waitForExit(child);
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(captured).resolves.toMatchObject({
      signal: "SIGTERM",
      deliveredToNext: false,
    });
    child.send("activate");
    await expect(replayed).resolves.toMatchObject({ signal: "SIGTERM" });
    const output = await summary;
    expect(
      output.match(/Brain SSE shutdown started; closed 0 active stream\(s\)/g),
    ).toHaveLength(1);
    await expect(exit).resolves.toEqual({ code: 143, signal: null });
    children.delete(child);
  });

  it("does not replay when the original signal already reached Next", async () => {
    const fixture = `
      const state = globalThis[Symbol.for("brain.startup-shutdown-state")];
      let appSignals = 0;
      let nextSignals = 0;
      let shutdownStarts = 0;
      const nextCleanup = () => { nextSignals += 1; };
      process.on("SIGINT", nextCleanup);
      process.on("SIGTERM", nextCleanup);
      process.stdout.write("next-ready\\n");
      process.on("message", (message) => {
        if (message !== "activate") return;
        state.activate(
          () => {
            shutdownStarts += 1;
            console.info("Brain SSE shutdown started; closed 0 active stream(s)");
          },
          () => {
            process.on("SIGINT", () => { appSignals += 1; });
            process.on("SIGTERM", () => { appSignals += 1; });
          },
        );
        setImmediate(() => {
          process.stdout.write(
            \`summary next=\${nextSignals} app=\${appSignals} begin=\${shutdownStarts} delivered=\${state.deliveredToNext} replayed=\${state.replayed}\\n\`,
          );
          process.exit(143);
        });
      });
      setInterval(() => {}, 1_000);
    `;
    const child = spawnFixture(fixture);

    await waitForOutput(child, "next-ready");
    const captured = waitForMessage(child, "brain-startup-signal-captured");
    const summary = waitForOutput(
      child,
      "summary next=1 app=0 begin=1 delivered=true replayed=false",
    );
    const exit = waitForExit(child);
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(captured).resolves.toMatchObject({
      signal: "SIGTERM",
      deliveredToNext: true,
    });
    child.send("activate");
    const output = await summary;
    expect(
      output.match(/Brain SSE shutdown started; closed 0 active stream\(s\)/g),
    ).toHaveLength(1);
    await expect(exit).resolves.toEqual({ code: 143, signal: null });
    children.delete(child);
  });

  it("records a repeated signal that reaches Next before the latch is consumed", async () => {
    const fixture = `
      const state = globalThis[Symbol.for("brain.startup-shutdown-state")];
      let nextSignals = 0;
      process.stdout.write("pre-next-ready\\n");
      process.on("message", (message) => {
        if (message === "install-next") {
          const nextCleanup = () => { nextSignals += 1; };
          process.on("SIGINT", nextCleanup);
          process.on("SIGTERM", nextCleanup);
          process.stdout.write("next-installed\\n");
          return;
        }
        if (message !== "activate") return;
        state.activate(
          () => console.info("Brain SSE shutdown started; closed 0 active stream(s)"),
          () => {
            process.on("SIGINT", () => {});
            process.on("SIGTERM", () => {});
          },
        );
        setImmediate(() => {
          process.stdout.write(
            \`summary next=\${nextSignals} delivered=\${state.deliveredToNext} replayed=\${state.replayed}\\n\`,
          );
          process.exit(143);
        });
      });
      setInterval(() => {}, 1_000);
    `;
    const child = spawnFixture(fixture);

    await waitForOutput(child, "pre-next-ready");
    const firstCapture = waitForMessage(
      child,
      "brain-startup-signal-captured",
    );
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(firstCapture).resolves.toMatchObject({
      deliveredToNext: false,
    });

    child.send("install-next");
    await waitForOutput(child, "next-installed");
    const secondCapture = waitForMessage(
      child,
      "brain-startup-signal-captured",
    );
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(secondCapture).resolves.toMatchObject({
      deliveredToNext: true,
    });

    const summary = waitForOutput(
      child,
      "summary next=1 delivered=true replayed=false",
    );
    const exit = waitForExit(child);
    child.send("activate");
    await expect(summary).resolves.toContain(
      "summary next=1 delivered=true replayed=false",
    );
    await expect(exit).resolves.toEqual({ code: 143, signal: null });
    children.delete(child);
  });

  it("removes capture after activation so a ready signal reaches Next and the app once", async () => {
    const fixture = `
      const state = globalThis[Symbol.for("brain.startup-shutdown-state")];
      let appSignals = 0;
      let nextSignals = 0;
      const nextCleanup = (signal) => {
        nextSignals += 1;
        if (signal === "SIGTERM") setImmediate(() => {
          process.stdout.write(\`summary next=\${nextSignals} app=\${appSignals}\\n\`);
          process.exit(143);
        });
      };
      process.on("SIGINT", nextCleanup);
      process.on("SIGTERM", nextCleanup);
      if (state.activate(() => {}, () => {
        process.on("SIGINT", () => { appSignals += 1; });
        process.on("SIGTERM", () => { appSignals += 1; });
      }) !== false) process.exit(12);
      process.stdout.write("activated\\n");
      setInterval(() => {}, 1_000);
    `;
    const child = spawnFixture(fixture);

    await waitForOutput(child, "activated");
    const summary = waitForOutput(child, "summary next=1 app=1");
    const exit = waitForExit(child);
    expect(child.kill("SIGTERM")).toBe(true);
    await expect(summary).resolves.toContain(
      "summary next=1 app=1",
    );
    await expect(exit).resolves.toEqual({ code: 143, signal: null });
    children.delete(child);
  });

  it("fails closed when instrumentation runs before Next installs both listeners", async () => {
    const fixture = `
      const state = globalThis[Symbol.for("brain.startup-shutdown-state")];
      process.on("SIGTERM", () => {});
      try {
        state.activate(() => {}, () => {});
        process.exit(12);
      } catch (error) {
        process.stdout.write(
          \`failed-closed consumed=\${state.consumed} capture=\${process.rawListeners("SIGTERM").includes(state.capture)} message=\${error.message}\\n\`,
        );
        process.exit(0);
      }
    `;
    const child = spawnFixture(fixture);
    const exit = waitForExit(child);

    await expect(
      waitForOutput(child, "failed-closed consumed=false capture=true"),
    ).resolves.toContain("Next SIGINT shutdown listener is not installed");
    await expect(exit).resolves.toEqual({ code: 0, signal: null });
    children.delete(child);
  });
});
