export const MAIL_SERVICE_HTTP_LIMITS = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  maxHeaders: 32,
  maxBodyBytes: 16 * 1024,
  // A send at the 8 MiB attachment cap carries 10.95 MiB of base64 inside a
  // JSON body, and a 1 MiB text body can expand to six JSON bytes per source
  // byte, so 20 MiB admits the whole band and nothing beyond it. readJsonBody
  // refuses any maxBodyBytes above maxDraftBodyBytes, so the two move together
  // or every attachment send answers 413.
  maxSendBodyBytes: 20 * 1024 * 1024,
  // A 1 MiB draft body can expand to six JSON bytes per source byte when it
  // contains escaped controls; recipient fields can also double on escaping.
  maxDraftBodyBytes: 20 * 1024 * 1024,
  headersTimeoutMs: 2_000,
  requestDeadlineMs: 5_000,
  accountConnectDeadlineMs: 10_000,
  providerOperationDeadlineMs: 10_000,
  attachmentIdleTimeoutMs: 30_000,
  attachmentAbsoluteTimeoutMs: 5 * 60_000,
  keepAliveTimeoutMs: 2_000,
  maxRequestsPerSocket: 32,
  maxConnections: 16,
  maxActiveReservations: 256,
  connectionsCheckingIntervalMs: 250,
});
