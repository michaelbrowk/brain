import { describe, expect, it } from "vitest";

import { compareSemver, imageTags, isPrerelease, parseSemver, resolveMinUpgradeFrom } from "./release-version.mjs";

describe("release versions", () => {
  it("parses strict semver without build metadata", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemver("0.9.0-rc.1").prerelease).toEqual(["rc", "1"]);
    for (const bad of ["v1.2.3", "1.2", "01.2.3", "1.2.3+build", "1.2.3-", ""]) {
      expect(() => parseSemver(bad)).toThrow("invalid release version");
    }
  });
  it("orders pre-releases below their release", () => {
    expect(compareSemver("0.9.0-rc.1", "0.9.0")).toBe(-1);
    expect(compareSemver("0.9.0-rc.2", "0.9.0-rc.10")).toBe(-1);
    expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });
  it("tags stable images with version, minor, and latest; pre-releases with version only", () => {
    expect(isPrerelease("0.9.0-rc.1")).toBe(true);
    expect(imageTags("ghcr.io/michaelbrowk/brain", "1.2.3")).toEqual([
      "ghcr.io/michaelbrowk/brain:1.2.3",
      "ghcr.io/michaelbrowk/brain:1.2",
      "ghcr.io/michaelbrowk/brain:latest",
    ]);
    expect(imageTags("ghcr.io/michaelbrowk/brain", "0.9.0-rc.1")).toEqual(["ghcr.io/michaelbrowk/brain:0.9.0-rc.1"]);
  });
  it("derives the minimum upgradable version from fixtures at or below the release", () => {
    expect(resolveMinUpgradeFrom("1.1.0", ["0.9.0", "1.0.0"])).toBe("0.9.0");
    expect(resolveMinUpgradeFrom("0.9.0-rc.1", ["0.9.0"])).toBe("0.9.0-rc.1");
    expect(resolveMinUpgradeFrom("0.9.0", [])).toBe("0.9.0");
  });
});
