/** The recording stand-in lives at `lib/mail/mail-client-fake.ts` now, because
 *  the every-account search under `lib/mail` has tests of its own and a lib
 *  test must not reach into `app/`. Re-exported here so the MCP tool tests
 *  keep the import they always had. */
export * from "@/lib/mail/mail-client-fake";
