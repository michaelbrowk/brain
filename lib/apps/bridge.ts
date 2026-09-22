import { z } from "zod";

/** THE ONLY THING THAT CROSSES THE FRAME BOUNDARY.
 *
 *  Request and answer, JSON, with an id on each pair. The frame has an opaque
 *  origin, so it can prove nothing about itself and `event.origin` is the
 *  useless string "null": the host trusts the frame it created and checks
 *  `event.source === iframe.contentWindow`, which is the one fact a page
 *  cannot forge.
 *
 *  Both ends read these schemas. The host parses what arrives before it acts
 *  on any of it, and the write routes parse the same payloads again on the
 *  server, because a browser-side check is a convenience and never an
 *  authority.
 *
 *  `rid` is the request's id and `id` is a page's. Spelling both `id` is the
 *  bug waiting in every protocol that tried it. */
export const BRIDGE_VERSION = 1;

export type AppTheme = "light" | "dark";

const MAX_TOAST_CHARS = 120;

const envelope = {
  v: z.literal(BRIDGE_VERSION),
  rid: z.string().min(1).max(64),
};

const oneLine = (max: number) =>
  z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .refine((value) => value.length > 0 && value.length <= max);

/** A discriminated union, because the `type` is what a refusal has to name
 *  and a plain union answers with every member's errors at once. `state.set`
 *  is the one member carrying a refinement, so it is applied to the union
 *  rather than to the member: zod 3's `discriminatedUnion` takes object
 *  schemas only, and a `ZodEffects` member does not compile. */
const appRequestUnion = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("hello") }),
  z.object({ ...envelope, type: z.literal("read.tree") }),
  z.object({ ...envelope, type: z.literal("read.page"), id: z.string().min(1).max(128) }),
  z.object({ ...envelope, type: z.literal("read.pages"), query: z.string().min(1).max(200) }),
  z.object({
    ...envelope,
    type: z.literal("write.page"),
    id: z.string().min(1).max(128),
    markdown: z.string(),
    /** Required, not optional: an app that has not read a page has no
     *  business replacing it, and "omit to force" is a door the owner never
     *  opened for an app. */
    rev: z.string().min(1).max(128),
  }),
  z.object({
    ...envelope,
    type: z.literal("create.page"),
    title: z.string().min(1).max(200),
    icon: z.string().max(16).optional(),
    markdown: z.string().default(""),
  }),
  z.object({ ...envelope, type: z.literal("state.get") }),
  z.object({ ...envelope, type: z.literal("state.set"), json: z.unknown() }),
  z.object({ ...envelope, type: z.literal("open"), id: z.string().min(1).max(128) }),
  z.object({ ...envelope, type: z.literal("toast"), text: oneLine(MAX_TOAST_CHARS) }),
]);

/** `z.unknown()` is OPTIONAL in zod 3, so `{ type: "state.set" }` with no
 *  payload at all parses and hands the host `undefined`, which would be
 *  written over the app's memory as the string "undefined". The key has to be
 *  there; what is under it may be anything JSON holds, `null` included. */
export const appRequestSchema = appRequestUnion.refine(
  (request) => request.type !== "state.set" || "json" in request,
  { message: "state.set needs a json payload" },
);

export type AppRequest = z.infer<typeof appRequestUnion>;

/** The MCP's own vocabulary, so one word means one thing wherever an agent or
 *  an app meets it. `read_only` is the share's, and `store_failed` is the
 *  notes folder failing, which is not the app doing anything wrong. */
export type AppRefusalReason =
  | "not_owned"
  | "rev_conflict"
  | "too_large"
  | "not_found"
  | "too_many"
  | "bad_request"
  | "read_only"
  | "store_failed";

export interface AppAnswer {
  readonly v: typeof BRIDGE_VERSION;
  readonly rid: string;
  readonly ok: true;
  readonly data: unknown;
}

export interface AppRefusal {
  readonly v: typeof BRIDGE_VERSION;
  readonly rid: string;
  readonly ok: false;
  readonly error: string;
  readonly reason: AppRefusalReason;
}

export function appAnswer(rid: string, data: unknown): AppAnswer {
  return { v: BRIDGE_VERSION, rid, ok: true, data };
}

export function appRefusal(
  rid: string,
  error: string,
  reason: AppRefusalReason,
): AppRefusal {
  return { v: BRIDGE_VERSION, rid, ok: false, error, reason };
}

export type AppEvent =
  | {
      readonly v: typeof BRIDGE_VERSION;
      readonly event: "theme";
      readonly theme: AppTheme;
      /** The values, not only the name. Spec §6 hands the frame Brain's
       *  tokens at `hello` and again here, because the values are what
       *  changed: an app told only "dark" would repaint with the light
       *  palette it cached at `hello`. */
      readonly tokens: Readonly<Record<string, string>>;
    }
  | { readonly v: typeof BRIDGE_VERSION; readonly event: "visibility"; readonly visible: boolean };

/** Nothing asked for an event, so it carries no request id. */
export function appEvent(
  event: "theme",
  theme: AppTheme,
  tokens: Readonly<Record<string, string>>,
): AppEvent;
export function appEvent(event: "visibility", visible: boolean): AppEvent;
export function appEvent(
  event: "theme" | "visibility",
  value: AppTheme | boolean,
  tokens?: Readonly<Record<string, string>>,
): AppEvent {
  return event === "theme"
    ? { v: BRIDGE_VERSION, event, theme: value as AppTheme, tokens: tokens ?? {} }
    : { v: BRIDGE_VERSION, event, visible: value as boolean };
}
