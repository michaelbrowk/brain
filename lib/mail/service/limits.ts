export const MAIL_SERVICE_HTTP_LIMITS = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  maxHeaders: 32,
  maxBodyBytes: 16 * 1024,
  maxSendBodyBytes: 1_200_000,
  // A 1 MiB draft body can expand to six JSON bytes per source byte when it
  // contains escaped controls; recipient fields can also double on escaping.
  maxDraftBodyBytes: 8 * 1024 * 1024,
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
