#!/usr/bin/env node

const MAX_HEALTH_BYTES = 64 * 1024;

let source = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  source += chunk;
  if (Buffer.byteLength(source, "utf8") > MAX_HEALTH_BYTES) {
    process.exit(2);
  }
});
process.stdin.on("end", () => {
  try {
    const value = JSON.parse(source);
    const build =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value.build
        : null;
    const status =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value.status
        : null;
    const apiVersion =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? value.apiVersion
        : null;
    const commit =
      build !== null && typeof build === "object" && !Array.isArray(build)
        ? build.commit
        : null;

    if (
      apiVersion !== 1 ||
      (status !== "ok" && status !== "degraded") ||
      typeof commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(commit)
    ) {
      process.exit(2);
    }
    process.stdout.write(commit);
  } catch {
    process.exit(2);
  }
});
