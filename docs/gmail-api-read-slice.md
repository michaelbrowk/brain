# Gmail API: first read/action slice

This module is the provider-specific HTTPS client behind Brain Mail. It does
not own account storage, OAuth UI, caching, or rendering.

Status (2026-07-19): the client is wired into the encrypted multi-account
store, per-account cache, bounded sync registry, reader/actions, durable send
path, and background scheduler. The Gmail metadata, sanitized body, and private
attachment paths are exercised read-only against the exact deployed artifact
before a release, not only in tests. Durable scheduler backoff and fair
multi-account draining, introduced here, stay a production candidate until
their own CI and restart canary pass.

## Integration contract

Create one `GmailApiClient` for the selected Gmail account and inject a
`GmailAccessTokenPort`:

```ts
const client = new GmailApiClient({
  tokenPort: {
    async getAccessToken({ forceRefresh }, signal) {
      // Resolve the selected account, refresh when required, and return a new
      // Buffer owned by GmailApiClient. The client wipes it after the request.
    },
  },
});
```

The port must return a new, non-empty `Buffer` on every call. It must never
return the persistent refresh token. `forceRefresh` is `true` only after Gmail
rejects a cached access token with HTTP 401. Map Google's OAuth
`invalid_grant` response to `new GmailAccessTokenError("invalid_grant")`; the
client then returns the stable `gmail_reauth_required` error.

The JavaScript runtime necessarily creates a short-lived immutable string for
the HTTP Authorization header. The owned source buffer is wiped in `finally`.
The client never logs tokens, response bodies, URLs, or provider error text.

## Available operations

- `listInboxThreads` and `listInboxMessages`
- `getThread` and `getMessage` with the validated Gmail `full` MIME resource
- `markThreadRead` / `markMessageRead` by adding or removing `UNREAD`
- `archiveThread` / `archiveMessage` by removing `INBOX`
- Draft-safe thread trash/restore, spam/not-spam, and star/unstar actions. Mixed
  threads mutate only non-Draft messages, and retries skip already-settled
  messages.

All requests use the fixed `https://gmail.googleapis.com/gmail/v1/users/me`
origin. Inbox lists always add `labelIds=INBOX`, exclude spam/trash, and request
only fields used by this slice.

## Safety bounds

- 50 items per Gmail page, 20 pages and 1,000 items per client call
- 20 threads per service sync pass, with at most two concurrent thread fetches
- 15 second request timeout
- 512 KiB list/action response, 12 MiB message, 32 MiB thread
- 200 messages per thread, 256 MIME parts, MIME depth 32
- 512 headers / 256 KiB aggregate header text
- 12 MiB aggregate inline base64url body data
- strict response fields, resource IDs, pagination-cycle detection, duplicate
  detection, JSON content type, UTF-8 decoding, and declared/streamed byte
  limits

The limits are exported as `GMAIL_API_LIMITS` for route and cache integration.

## Stable errors

The public error is only a `GmailApiError` code; Google response text is not
propagated:

- `gmail_reauth_required`: OAuth `invalid_grant` or a second HTTP 401
- `gmail_rate_limited`: HTTP 429 or a known Gmail quota reason on HTTP 403
- `gmail_permission_denied`, `gmail_not_found`, `gmail_conflict`
- `gmail_request_invalid`, `gmail_request_cancelled`, `gmail_request_timeout`
- `gmail_service_unavailable`, `gmail_response_invalid`

## Local integration now present

- an account-bound access-token port that decrypts only the selected refresh
  token, refreshes it through Google's fixed token endpoint, and wipes owned
  buffers.
- per-account SQLite thread/message cache with initial and `historyId`
  incremental sync.
- bounded list, read, sync, read/unread, archive, trash/restore, spam/not-spam,
  and star/unstar service routes.
- compose and reply with server-derived reply headers, a durable idempotent
  outbox, and Gmail `messages.send`.
- explicit `delivery_unknown` after an ambiguous send, with no automatic
  duplicate retry.
- serialized background sync and visible-browser refresh.
- durable per-account retry state with exponential 30-second to 30-minute
  backoff, capped Gmail `Retry-After`, and an authoritative gate shared by
  background and manual sync.
- fair round-robin draining of at most six provider pages per burst; unfinished
  accounts continue after 250 ms while completed accounts return to the normal
  60-second interval.
- credential-version recovery: a newly persisted OAuth grant clears a parked
  backoff or `reauth_required` state without discarding the staged Gmail page.
- aggregate health reports the oldest successful account sync and a stable,
  body-free worst error code while readiness stays degraded until rollout
  canaries complete.
- a bounded raw-message source, disk-backed content cache, isolated no-network
  MIME worker, sanitized text/HTML reader output, and private streamed
  attachment downloads.
- local per-mailbox search over cached sender names/addresses, subjects, and
  previews. SQLite FTS5 uses normalized Unicode AND-prefix terms, bounded
  500-thread backfill batches, a 500-result ceiling, and cursor bindings to the
  account, mailbox, query, cache generation, History observation, and search
  revision. Search never fetches message bodies or calls Gmail.

## Still not included

- arbitrary custom labels, permanent deletion, and offline body pinning.
- User-facing system-folder action controls; this slice exposes the exact
  backend contract only.
- a production claim for this slice's scheduler changes; health does not become
  ready merely because state is present.

Four things this slice left out have since landed and are no longer absent:
custom-domain IMAP sync and SMTP send, remote-image proxying, verified inline
CID rendering, and drafts. `docs/mail-architecture.md` is the current picture;
this document is the record of one slice.

## Google references

- [Gmail threads.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads/list)
- [Gmail messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- [Gmail thread resource and modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.threads)
- [Gmail message resource and modify](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages)
- [Gmail API error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors)
- [Google OAuth 2.0 refresh errors](https://developers.google.com/identity/protocols/oauth2)
