import { describe, expect, it } from "vitest";
import { NotionUploadAdmission } from "./upload-admission";

describe("Notion upload admission", () => {
  it("admits one decode at a time and releases idempotently", () => {
    const admission = new NotionUploadAdmission();
    const release = admission.tryAcquire();

    expect(release).not.toBeNull();
    expect(admission.tryAcquire()).toBeNull();
    release?.();
    release?.();

    expect(admission.tryAcquire()).not.toBeNull();
  });
});
