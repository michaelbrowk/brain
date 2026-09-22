import { appendMcpActivity } from "@/lib/mcp/activity-log";

/** ONE LINE PER BRIDGE WRITE, WHATEVER BECAME OF IT.
 *
 *  Both write routes under this prefix record what an app did the way
 *  `pageWrite` in `app/api/mcp/route.ts` records what a grant did: the line
 *  is written for the refusals too, because an app that cannot change the
 *  notebook silently is the whole point of the bridge.
 *
 *  Here rather than in each route because the two would otherwise hold two
 *  copies of the same swallow, and a fix to one copy is a fix the other keeps
 *  missing.
 *
 *  Swallowed for the reason every other activity append is: a write that has
 *  already landed must not reach the caller as a failure, or it will do it
 *  again. */
export interface AppBridgeLine {
  /** `appWriteClient(title)`, never a name the frame sent. */
  readonly client: string;
  readonly tool: string;
  readonly change: string;
  /** The page that moved, once there is one. A refusal before the create has
   *  no page to name, and a line naming none is the honest one. */
  readonly page?: string;
  readonly outcome: string;
  /** The page's own title, out of the store, for the bell's row and never for
   *  the line on disk. */
  readonly label?: string;
}

export async function logAppBridgeWrite(line: AppBridgeLine): Promise<void> {
  try {
    await appendMcpActivity(
      {
        at: new Date().toISOString(),
        client: line.client,
        tool: line.tool,
        ...(line.page === undefined ? {} : { page: line.page }),
        change: line.change,
        outcome: line.outcome,
      },
      line.label === undefined ? undefined : { label: line.label },
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[brain/apps] activity line dropped: ${reason}`);
  }
}
