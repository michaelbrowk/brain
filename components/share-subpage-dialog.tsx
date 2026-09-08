"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useId, useState, type FormEvent } from "react";
import { cleanVisitorTitle, VISITOR_TITLE_MAX } from "@/lib/sharing";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { DialogHeader } from "./ui/dialog-header";

/** What the island did with the title. A refusal carries the sentence to
 *  show and whether pressing again could ever help: a share that is full or
 *  a link that has stopped granting writes will answer the same way to the
 *  next press, and a page that was created and could not be linked must not
 *  be created twice. */
export type ShareSubpageOutcome =
  | { ok: true }
  | { ok: false; message: string; retry: boolean };

/** Why the field is not a rename box. A visitor may name a page at the
 *  moment they create it and never again, so the sentence says that before
 *  the press rather than after it. */
export const SHARE_SUBPAGE_NOTE =
  "The name is set when the page is created. Editing through a link cannot change it later.";

export const SHARE_SUBPAGE_TITLE = "New page";

/** The naming step, and the whole of a visitor's authority over a title.
 *
 *  It is a dialog rather than a field in the document because the editor is
 *  locked while it is open: the slash menu holds the trigger text in place
 *  so the new page's link can replace it, and a question asked inside a
 *  frozen editor has nowhere to be typed. It is paper rather than the app's
 *  thick material because a share page carries no glass (DESIGN.md ban 10),
 *  and a link is opened in the browsers where a blurred layer is least
 *  reliable. */
export function ShareSubpageDialog({
  onCreate,
  onClose,
}: {
  onCreate: (title: string) => Promise<ShareSubpageOutcome>;
  onClose: () => void;
}) {
  const titleId = useId();
  const noteId = useId();
  const errorId = useId();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal that another press cannot answer. The form becomes the
  // sentence and one way out, so nobody creates a second page trying to fix
  // the first.
  const [settled, setSettled] = useState(false);

  // The route's own rule for a usable title, so a name it would keep as
  // "Untitled" is never sent and the label placed in the page is the title
  // the file actually carries.
  const title = cleanVisitorTitle(draft);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title || busy || settled) return;
    setBusy(true);
    setError(null);
    const outcome = await onCreate(title);
    if (outcome.ok) {
      onClose();
      return;
    }
    setBusy(false);
    setError(outcome.message);
    setSettled(!outcome.retry);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          data-share-subpage-dialog
          aria-describedby={undefined}
          // Focus goes back to the editor from the island, once the slash
          // menu has unlocked it. Restoring it here would land on a view
          // that is still not editable.
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="brain-share-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] w-[min(calc(100vw-2rem),420px)] overflow-hidden outline-none"
        >
          <DialogHeader title={SHARE_SUBPAGE_TITLE} />
          <form onSubmit={submit} className="px-5 pb-4">
            <label htmlFor={titleId} className="block text-caption text-ink-3">
              Page title
            </label>
            <Field
              autoFocus
              id={titleId}
              name="title"
              className="mt-1"
              maxLength={VISITOR_TITLE_MAX}
              value={draft}
              disabled={busy || settled}
              aria-describedby={error ? errorId : noteId}
              onChange={(event) => {
                setDraft(event.target.value.replace(/[\r\n]+/g, " "));
                if (error) setError(null);
              }}
            />
            <p id={noteId} className="mt-2 text-caption text-ink-3">
              {SHARE_SUBPAGE_NOTE}
            </p>
            {error && (
              <p
                id={errorId}
                role="alert"
                aria-live="assertive"
                className="mt-2 text-caption text-ink-2"
              >
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              {settled ? (
                <Button type="button" variant="ink" onClick={onClose}>
                  Close
                </Button>
              ) : (
                <>
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={busy}
                    onClick={onClose}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" variant="ink" disabled={!title || busy}>
                    {busy ? "Creating…" : "Create page"}
                  </Button>
                </>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
