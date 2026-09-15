import { NextResponse } from "next/server";
import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { readAgentSends, resolveAgentSendThread } from "@/lib/mcp/agent-sends";

export const dynamic = "force-dynamic";

/** WHICH SENT THREADS AN AGENT PUT ON THE WIRE, for the Sent mailbox caption.
 *
 *  The Sent row is the provider's own row and carries no operation id, so the
 *  join happens here: a mark is written at send time with the operation, and
 *  the thread behind that operation is looked up once and written back. The
 *  answer holds three ids and an app name. No subject, no address, no body.
 */

/** A send with no thread yet and a status that will not change again is never
 *  going to get one: an IMAP account keeps no thread id, and a failed send has
 *  no Sent copy. Asked once per process, then left alone, so a caption that is
 *  not coming costs one round trip rather than one on every visit to Sent. */
const settled = new Set<string>();

/** Resolves left for the next visit once a request has spent this many. The
 *  marks file holds up to 200; a cold process that had to ask for all of them
 *  at once would make opening Sent wait on 200 round trips. */
const RESOLVES_PER_REQUEST = 25;

function willNeverHaveThread(status: string): boolean {
  return status === "sent" || status === "failed" || status === "delivery_unknown";
}

export async function GET(request: Request) {
  const marks = await readAgentSends();
  const resolved: Array<{
    accountId: string;
    threadId: string;
    clientName: string;
  }> = [];
  let budget = RESOLVES_PER_REQUEST;
  let client: ReturnType<typeof createBrainMailClient> | null = null;

  for (const mark of marks) {
    if (mark.threadId !== null) {
      resolved.push({
        accountId: mark.accountId,
        threadId: mark.threadId,
        clientName: mark.clientName,
      });
      continue;
    }
    if (settled.has(mark.operationId) || budget === 0) continue;
    budget -= 1;
    try {
      client ??= createBrainMailClient();
      const operation = await client.getSendOperation(mark.operationId, request.signal);
      if (operation.threadId === null) {
        if (willNeverHaveThread(operation.status)) settled.add(mark.operationId);
        continue;
      }
      await resolveAgentSendThread(mark.operationId, operation.threadId);
      resolved.push({
        accountId: mark.accountId,
        threadId: operation.threadId,
        clientName: mark.clientName,
      });
    } catch {
      // A caption is not worth a broken mail list. The mark keeps its null and
      // the next visit asks again, since a socket that was down is not a send
      // that has no thread.
    }
  }

  return NextResponse.json({ marks: resolved });
}
