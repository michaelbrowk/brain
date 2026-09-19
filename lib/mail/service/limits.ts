export const MAIL_SERVICE_HTTP_LIMITS = Object.freeze({
  maxHeaderBytes: 8 * 1024,
  maxHeaders: 32,
  maxBodyBytes: 16 * 1024,
  // A send at the 10 MiB attachment cap carries 13.68 MiB of base64 inside a
  // JSON body, and a 1 MiB text body can expand to six JSON bytes per source
  // byte, so the band is 19.68 MiB and 24 MiB admits the whole of it and
  // nothing beyond it. readJsonBody refuses any maxBodyBytes above
  // maxDraftBodyBytes, so the two move together or every attachment send
  // answers 413. The edge has to stay above this figure as well:
  // ops/nginx-reference.test.ts checks the reference vhost against it, and the
  // droplet's own client_max_body_size is 30m.
  maxSendBodyBytes: 24 * 1024 * 1024,
  // A 1 MiB draft body can expand to six JSON bytes per source byte when it
  // contains escaped controls; recipient fields can also double on escaping.
  maxDraftBodyBytes: 24 * 1024 * 1024,
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
