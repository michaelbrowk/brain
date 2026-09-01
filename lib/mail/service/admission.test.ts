import { describe, expect, it } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";
import {
  AtomicMailSystemAdmission,
  EMPTY_MAIL_SYSTEM_USAGE,
  MailAdmissionError,
} from "./admission";
import { MAIL_SERVICE_HTTP_LIMITS } from "./limits";

describe("AtomicMailSystemAdmission", () => {
  it("atomically lets only one concurrent reservation reach a ceiling", async () => {
    const admission = new AtomicMailSystemAdmission();
    const attempts = await Promise.allSettled([
      admission.reserve("smtp-a", { concurrentSmtpSubmissions: 1 }),
      admission.reserve("smtp-b", { concurrentSmtpSubmissions: 1 }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(
      MAIL_RESOURCE_LIMITS.concurrentSmtpSubmissions,
    );
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "capacity_exceeded" }),
    });
    expect(await admission.readUsage()).toMatchObject({
      concurrentSmtpSubmissions: 1,
    });
  });

  it("releases the exact reservation once and allows the capacity to be reused", async () => {
    const admission = new AtomicMailSystemAdmission();
    const first = await admission.reserve("parser-a", {
      concurrentMimeParsers: 1,
      temporaryBytes: 1024,
    });

    await admission.release(first.reservationId);
    await expect(admission.release(first.reservationId)).rejects.toMatchObject({
      code: "reservation_not_found",
    });
    await expect(
      admission.reserve("parser-b", { concurrentMimeParsers: 1 }),
    ).resolves.toMatchObject({
      reservationId: expect.stringMatching(/^reservation-r[0-9a-f]{32}$/),
    });
  });

  it("cannot let a stale pre-restart release free a new reservation", async () => {
    const beforeRestart = new AtomicMailSystemAdmission();
    const stale = await beforeRestart.reserve("smtp-before-restart", {
      concurrentSmtpSubmissions: 1,
    });
    const afterRestart = new AtomicMailSystemAdmission();
    const current = await afterRestart.reserve("smtp-after-restart", {
      concurrentSmtpSubmissions: 1,
    });

    expect(current.reservationId).not.toBe(stale.reservationId);
    await expect(afterRestart.release(stale.reservationId)).rejects.toMatchObject({
      code: "reservation_not_found",
    });
    expect(await afterRestart.readUsage()).toMatchObject({
      concurrentSmtpSubmissions: 1,
    });
  });

  it("rejects empty, zero, unknown, oversized, or duplicated admission", async () => {
    const admission = new AtomicMailSystemAdmission();

    await expect(admission.reserve("empty", {})).rejects.toBeInstanceOf(
      MailAdmissionError,
    );
    await expect(
      admission.reserve("zero", { concurrentFetchStreams: 0 }),
    ).rejects.toMatchObject({ code: "admission_invalid" });
    await expect(
      admission.reserve("unknown", { unknown: 1 } as never),
    ).rejects.toMatchObject({ code: "admission_invalid" });
    await expect(
      admission.reserve("oversized", {
        temporaryBytes: MAIL_RESOURCE_LIMITS.maxTemporaryBytes + 1,
      }),
    ).rejects.toMatchObject({ code: "admission_invalid" });

    await admission.reserve("same-operation", { concurrentFetchStreams: 1 });
    await expect(
      admission.reserve("same-operation", { concurrentFetchStreams: 1 }),
    ).rejects.toMatchObject({ code: "operation_already_reserved" });
  });

  it("returns immutable snapshots without exposing internal counters", async () => {
    const admission = new AtomicMailSystemAdmission();
    const usage = await admission.readUsage();

    expect(usage).toEqual(EMPTY_MAIL_SYSTEM_USAGE);
    expect(Object.isFrozen(usage)).toBe(true);
    expect(() => {
      (usage as { accounts: number }).accounts = 3;
    }).toThrow();
    expect((await admission.readUsage()).accounts).toBe(0);
  });

  it("bounds active reservation records even for one-byte deltas", async () => {
    const admission = new AtomicMailSystemAdmission();
    const reservations = await Promise.all(
      Array.from(
        { length: MAIL_SERVICE_HTTP_LIMITS.maxActiveReservations },
        (_value, index) =>
          admission.reserve(`temporary-${index}`, { temporaryBytes: 1 }),
      ),
    );

    await expect(
      admission.reserve("temporary-overflow", { temporaryBytes: 1 }),
    ).rejects.toMatchObject({ code: "capacity_exceeded" });
    await admission.release(reservations[0].reservationId);
    await expect(
      admission.reserve("temporary-reused", { temporaryBytes: 1 }),
    ).resolves.toMatchObject({
      reservationId: expect.stringMatching(/^reservation-r[0-9a-f]{32}$/),
    });
  });
});
