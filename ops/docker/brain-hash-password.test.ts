import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";

const script = path.join(process.cwd(), "ops", "docker", "brain-hash-password.mjs");

describe("hash-password entrypoint", () => {
  it("prints a bcrypt hash that verifies against the stdin password", () => {
    const out = execFileSync(process.execPath, [script], { input: "correct horse\n" }).toString().trim();
    expect(out.startsWith("$2")).toBe(true);
    expect(bcrypt.compareSync("correct horse", out)).toBe(true);
    expect(bcrypt.compareSync("wrong", out)).toBe(false);
  });

  it("strips one trailing CRLF and keeps inner whitespace", () => {
    const out = execFileSync(process.execPath, [script], { input: " two  words \r\n" }).toString();
    expect(out.endsWith("\n")).toBe(true);
    expect(bcrypt.compareSync(" two  words ", out.trim())).toBe(true);
  });

  it("refuses empty input with exit 2 and a one-line reason", () => {
    const r = spawnSync(process.execPath, [script], { input: "   \n" });
    expect(r.status).toBe(2);
    expect(r.stderr.toString()).toBe("hash-password: read the password on stdin, nothing arrived\n");
    expect(r.stdout.toString()).toBe("");
  });
});
