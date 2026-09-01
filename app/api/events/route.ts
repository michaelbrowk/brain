import {
  brainEvents,
  latestStoreEventSequence,
  replayStoreEvents,
  type SequencedStoreEvent,
} from "@/lib/store/events";
import { registerActiveSseClose } from "@/lib/store/sse-shutdown";

export const dynamic = "force-dynamic";

/** Server-Sent Events: streams every store mutation to open clients so an
 *  external write (MCP, another tab) shows up live instead of going stale. */
export async function GET(req: Request) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* stream already closed */
        }
      };
      const sendEvent = (
        event: string | null,
        data: unknown,
        sequence: number,
      ) => {
        send(
          `${event ? `event: ${event}\n` : ""}id: ${sequence}\ndata: ${JSON.stringify(data)}\n\n`,
        );
      };
      const onChange = (ev: SequencedStoreEvent) =>
        sendEvent(null, ev, ev.sequence);
      brainEvents.on("change", onChange);

      const cursorHeader = req.headers.get("last-event-id");
      const cursor = cursorHeader === null ? null : Number(cursorHeader);
      if (cursor === null) {
        const latest = latestStoreEventSequence();
        sendEvent("ready", { sequence: latest }, latest);
      } else {
        const replay = replayStoreEvents(cursor);
        if (replay.reconcile) {
          sendEvent(
            "reconcile",
            { reason: "event-gap", sequence: replay.latestSequence },
            replay.latestSequence,
          );
        } else {
          replay.events.forEach((event) => sendEvent(null, event, event.sequence));
        }
      }
      // periodic comment keeps proxies from cutting an idle connection
      const hb = setInterval(() => send(": hb\n\n"), 25000);
      let unregisterShutdown = () => {};
      const close = () => {
        if (closed) return;
        closed = true;
        unregisterShutdown();
        clearInterval(hb);
        brainEvents.off("change", onChange);
        req.signal.removeEventListener("abort", close);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      unregisterShutdown = registerActiveSseClose(close);
      if (closed) return;
      if (req.signal.aborted) close();
      else req.signal.addEventListener("abort", close, { once: true });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      // The stream itself stays open indefinitely. Marking the underlying
      // HTTP/1.1 connection non-reusable lets Next's server.close() finish
      // after the shutdown callback closes this response.
      Connection: "close",
      "X-Accel-Buffering": "no", // don't let nginx buffer the stream
    },
  });
}
