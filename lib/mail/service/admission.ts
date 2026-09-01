import { randomBytes } from "node:crypto";

import type {
  MailSystemAdmissionPort,
  MailSystemUsage,
} from "../ports";
import {
  admitMailSystemUsage,
  validateMailSystemReservationDelta,
} from "../security";
import { MAIL_SERVICE_HTTP_LIMITS } from "./limits";

const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RESERVATION_ID = /^reservation-r[0-9a-f]{32}$/;

export const EMPTY_MAIL_SYSTEM_USAGE: MailSystemUsage = Object.freeze({
  accounts: 0,
  mailboxes: 0,
  activeImapConnections: 0,
  idleSessions: 0,
  concurrentFetchStreams: 0,
  concurrentMimeParsers: 0,
  concurrentSmtpSubmissions: 0,
  queuedSubmissions: 0,
  cacheBytes: 0,
  cacheMessages: 0,
  temporaryBytes: 0,
  walBytes: 0,
  openFileDescriptors: 0,
});

export type MailAdmissionErrorCode =
  | "admission_invalid"
  | "capacity_exceeded"
  | "operation_already_reserved"
  | "reservation_not_found";

export class MailAdmissionError extends Error {
  readonly code: MailAdmissionErrorCode;

  constructor(code: MailAdmissionErrorCode) {
    super(code);
    this.name = "MailAdmissionError";
    this.code = code;
  }
}

interface ActiveReservation {
  readonly operationId: string;
  readonly delta: Readonly<Partial<MailSystemUsage>>;
}

/** One process owns this object, so validation and mutation happen in one
 * synchronous turn before the returned Promise can yield. */
export class AtomicMailSystemAdmission implements MailSystemAdmissionPort {
  private usage: MailSystemUsage;
  private readonly reservations = new Map<string, ActiveReservation>();
  private readonly reservationByOperation = new Map<string, string>();

  constructor(initialUsage: MailSystemUsage = EMPTY_MAIL_SYSTEM_USAGE) {
    admitMailSystemUsage(initialUsage);
    this.usage = cloneUsage(initialUsage);
  }

  async readUsage(): Promise<MailSystemUsage> {
    return cloneUsage(this.usage);
  }

  async reserve(
    operationId: string,
    inputDelta: Partial<MailSystemUsage>,
  ): Promise<{ readonly reservationId: string }> {
    if (!SAFE_OPERATION_ID.test(operationId)) {
      throw new MailAdmissionError("admission_invalid");
    }
    if (this.reservationByOperation.has(operationId)) {
      throw new MailAdmissionError("operation_already_reserved");
    }
    if (
      this.reservations.size >= MAIL_SERVICE_HTTP_LIMITS.maxActiveReservations
    ) {
      throw new MailAdmissionError("capacity_exceeded");
    }

    let delta: Readonly<Partial<MailSystemUsage>>;
    try {
      delta = validateMailSystemReservationDelta(inputDelta);
    } catch {
      throw new MailAdmissionError("admission_invalid");
    }
    if (
      Object.keys(delta).length === 0 ||
      !Object.values(delta).some((value) => value !== undefined && value > 0)
    ) {
      throw new MailAdmissionError("admission_invalid");
    }

    const next = { ...this.usage };
    for (const [field, value] of Object.entries(delta) as Array<
      [keyof MailSystemUsage, number]
    >) {
      next[field] += value;
    }
    try {
      admitMailSystemUsage(next);
    } catch {
      throw new MailAdmissionError("capacity_exceeded");
    }

    const reservationId = this.createReservationId();
    this.usage = cloneUsage(next);
    this.reservations.set(
      reservationId,
      Object.freeze({ operationId, delta }),
    );
    this.reservationByOperation.set(operationId, reservationId);
    return Object.freeze({ reservationId });
  }

  async release(reservationId: string): Promise<void> {
    if (!SAFE_RESERVATION_ID.test(reservationId)) {
      throw new MailAdmissionError("reservation_not_found");
    }
    const reservation = this.reservations.get(reservationId);
    if (!reservation) {
      throw new MailAdmissionError("reservation_not_found");
    }

    const next = { ...this.usage };
    for (const [field, value] of Object.entries(reservation.delta) as Array<
      [keyof MailSystemUsage, number]
    >) {
      next[field] -= value;
    }
    admitMailSystemUsage(next);
    this.usage = cloneUsage(next);
    this.reservations.delete(reservationId);
    this.reservationByOperation.delete(reservation.operationId);
  }

  private createReservationId(): string {
    let reservationId: string;
    do {
      reservationId = `reservation-r${randomBytes(16).toString("hex")}`;
    } while (this.reservations.has(reservationId));
    return reservationId;
  }
}

function cloneUsage(usage: MailSystemUsage): MailSystemUsage {
  return Object.freeze({ ...usage });
}
