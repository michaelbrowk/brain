import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const output = path.join(root, ".next", "standalone", "mail-service");

await rm(output, { recursive: true, force: true });
await execFileAsync(path.join(root, "node_modules", ".bin", "tsc"), [
  "--project",
  path.join(root, "tsconfig.mail-service.json"),
]);
await mkdir(output, { recursive: true });

const imapBundle = await build({
  entryPoints: [path.join(root, "lib", "mail", "service", "imapflow-adapter.ts")],
  outfile: path.join(output, "service", "imapflow-adapter.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
  external: ["../ports", "../security", "./account-types"],
});

// The mail service is emitted as CommonJS. Bundle jose into the provider
// boundary so the immutable artifact never depends on Next's traced modules or
// a production node_modules layout.
const gmailOAuthBundle = await build({
  entryPoints: [
    path.join(root, "lib", "mail", "providers", "gmail", "oauth.ts"),
  ],
  outfile: path.join(output, "providers", "gmail", "oauth.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

const mimeParserBundle = await build({
  entryPoints: [
    path.join(root, "lib", "mail", "service", "mime-parser-worker.ts"),
  ],
  outfile: path.join(output, "service", "mime-parser-worker.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});

// SMTP egress pulls in ws and the Sent-copy adapter pulls in ImapFlow. Keep
// that dependency surface in one audited bundle instead of relying on a
// production node_modules tree beside the compiled service.
const smtpRuntimeBundle = await build({
  entryPoints: [
    path.join(root, "lib", "mail", "service", "smtp-runtime.ts"),
  ],
  outfile: path.join(output, "service", "smtp-runtime.js"),
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  sourcemap: false,
  legalComments: "none",
  logLevel: "info",
  metafile: true,
});
await Promise.all(
  [
    "account-access.js",
    "imap-sent-copy.js",
    "smtp-runtime-config.js",
    "smtp-transport.js",
    "smtp-wire.js",
    "smtp-worker.js",
  ].map((name) =>
    rm(path.join(output, "service", name), { force: true }),
  ),
);

await writeFile(
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
  await createThirdPartyNotices([
    ...new Set([
      ...Object.keys(imapBundle.metafile.inputs),
      ...Object.keys(gmailOAuthBundle.metafile.inputs),
      ...Object.keys(mimeParserBundle.metafile.inputs),
      ...Object.keys(smtpRuntimeBundle.metafile.inputs),
    ]),
  ]),
  { mode: 0o444 },
);

const rawCommit = process.env.BRAIN_BUILD_SHA ?? process.env.GITHUB_SHA;
const rawBuiltAt = process.env.BRAIN_BUILD_TIME;
const development = rawCommit === undefined || rawCommit === "development";
const commit = development ? "dev" : rawCommit;
const builtAt = development && rawBuiltAt === undefined ? "dev" : rawBuiltAt;
if (
  (commit === "dev") !== (builtAt === "dev") ||
  (commit !== "dev" && !/^[a-f0-9]{40}$/.test(commit ?? "")) ||
  (builtAt !== "dev" &&
    (typeof builtAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(builtAt) ||
      Number.isNaN(Date.parse(builtAt))))
) {
  throw new Error("mail service build identity is invalid");
}

await writeFile(
  path.join(output, "build.json"),
  `${JSON.stringify({ commit, builtAt })}\n`,
  { mode: 0o444 },
);

async function createThirdPartyNotices(inputs) {
  const packages = new Map();
  for (const input of inputs) {
    if (!input.includes("node_modules")) continue;
    const packageRoot = await findPackageRoot(path.resolve(root, input));
    const packageJson = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    if (
      typeof packageJson.name !== "string" ||
      typeof packageJson.version !== "string" ||
      typeof packageJson.license !== "string"
    ) {
      const identity = `${String(packageJson.name ?? "unknown")}@${String(
        packageJson.version ?? "unknown",
      )}`;
      throw new Error(
        `mail bundle package ${identity} metadata is invalid at ${path.relative(
          root,
          packageRoot,
        )}`,
      );
    }
    const key = `${packageJson.name}@${packageJson.version}`;
    if (packages.has(key)) continue;
    const names = await readdir(packageRoot);
    const licenseNames = names
      .filter((name) => /^(?:licen[cs]e|copying)(?:[-.]|$)/i.test(name))
      .sort();
    const licenseName =
      licenseNames.find((name) => /^licen[cs]e(?:[-.]mit)(?:\.txt)?$/i.test(name)) ??
      licenseNames[0];
    if (!licenseName) {
      throw new Error(`mail bundle package ${key} has no license file`);
    }
    const licenseText = await readFile(
      path.join(packageRoot, licenseName),
      "utf8",
    );
    packages.set(key, {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
      licenseText: licenseText.trim(),
    });
  }
  if (!packages.has("imapflow@1.4.7")) {
    throw new Error("mail bundle does not contain the pinned ImapFlow package");
  }
  if (!packages.has("jose@6.2.9")) {
    throw new Error("mail bundle does not contain the pinned jose package");
  }
  if (!packages.has("mailparser@3.9.14")) {
    throw new Error("mail bundle does not contain the pinned mailparser package");
  }
  if (!packages.has("@zone-eu/mailsplit@5.4.14")) {
    throw new Error("mail bundle does not contain the pinned mailsplit package");
  }
  if (!packages.has("ws@8.21.0")) {
    throw new Error("mail bundle does not contain the pinned ws package");
  }
  if (!packages.has("htmlparser2@10.1.0")) {
    throw new Error("mail bundle does not contain the pinned htmlparser2 package");
  }
  const sections = [...packages.values()]
    .sort((left, right) =>
      `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
    )
    .map(
      (entry) =>
        `${entry.name}@${entry.version} (${entry.license})\n\n${entry.licenseText}`,
    );
  return [
    "Brain Mail bundled third-party notices",
    "Generated from the exact frozen dependency graph. Do not edit manually.",
    ...sections,
    "",
  ].join("\n\n---\n\n");
}

async function findPackageRoot(input) {
  let current = path.dirname(input);
  while (current !== path.dirname(current)) {
    try {
      const candidate = JSON.parse(
        await readFile(path.join(current, "package.json"), "utf8"),
      );
      if (typeof candidate.name === "string" && typeof candidate.version === "string") {
        return current;
      }
      current = path.dirname(current);
    } catch {
      current = path.dirname(current);
    }
  }
  throw new Error("mail bundle package root is missing");
}
