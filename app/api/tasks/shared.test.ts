// THE PATCH SURFACE IS ONE LIST, WRITTEN TWICE.
//
// `PATCH_FIELDS` says which names a caller may send and `patchBodySchema` says
// what each one may hold. They are two literals in one file, so a field added
// to either and forgotten on the other is a silent hole: a name on the
// allowlist with no parser reaches `applyTaskPatch` unchecked, and a parser
// with no name on the allowlist is refused at the door and never runs. This
// asserts they are the same list.

import { describe, expect, it } from "vitest";

import { PATCH_FIELDS, patchBodySchema } from "./shared";

describe("the patch surface", () => {
  it("names the same fields in the allowlist and in the schema", () => {
    expect(Object.keys(patchBodySchema.shape).sort()).toEqual([...PATCH_FIELDS].sort());
  });
});
