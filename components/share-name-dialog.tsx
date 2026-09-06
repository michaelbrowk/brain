"use client";

import { useId, useState } from "react";
import { normalizeVisitorName, VISITOR_NAME_MAX } from "@/lib/sharing";
import { Button } from "./ui/button";
import { Field } from "./ui/field";

const WRONG_PASSWORD = "Wrong password";
const NEEDS_PASSWORD = "Enter the password to edit.";
// The owner closed editing, or the link expired, while this page was open.
// Trying again cannot fix that, so the message does not ask for it.
const CLOSED =
  "This page is no longer open for editing. You can still read it.";

/** Without scripts the form cannot work: `ready` comes from React state that
 *  starts empty, so the submit ships disabled and never enables, and there is
 *  no action to post to. The rule hides the control and says why, rather than
 *  leaving a dead button between the title and the text. It lives outside the
 *  element it hides, so the sentence survives the rule. */
const NO_SCRIPT_HTML =
  "<style>[data-share-name-dialog]{display:none}</style>" +
  '<p class="brain-share-name text-caption text-ink-3">Editing this page needs JavaScript. You can read the page as it is.</p>';

/** Asked once per edit cookie, before the first edit, and only of someone who
 *  says they want to edit. It opens as one quiet control, because every reader
 *  of an editable link meets this and most of them only want to read: a form
 *  with no way out, between the title and the first paragraph, is an
 *  obligation a reader never took on. It belongs to the server render beside
 *  the password gate, so it appears without an editor bundle: the mint happens
 *  first and the island arrives on the reload after it.
 *
 *  The password field is not drawn until the mint asks for it. On a locked
 *  root the visitor came through the gate and that read cookie stands in for
 *  the password, so a field would be a question already answered; on an open
 *  one there is nothing to ask. Either can change under an open page -- the
 *  cookie expires, the share is re-issued, the owner adds a password -- and
 *  each of those is a 401, so a 401 is what draws the field. A control lives
 *  exactly as long as its reason. */
export function ShareNameDialog({
  id,
  onMinted = () => location.reload(),
}: {
  id: string;
  onMinted?: () => void;
}) {
  const nameId = useId();
  const passwordId = useId();
  const errorId = useId();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The server's own rule for a usable name, so a name it will refuse never
  // gets as far as a request the visitor cannot learn anything from.
  const ready = normalizeVisitorName(name) !== null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    let minted = false;
    try {
      const res = await fetch("/api/share-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: "edit",
          id,
          name,
          ...(password ? { password } : {}),
        }),
      });
      if (res.ok) {
        minted = true;
        onMinted();
        return;
      }
      if (res.status === 401) {
        if (askPassword && password) {
          setError(WRONG_PASSWORD);
          setPassword("");
        } else {
          setError(NEEDS_PASSWORD);
          setAskPassword(true);
        }
      } else {
        setError(
          res.status === 429
            ? "Too many attempts. Wait a bit."
            : res.status === 404
              ? CLOSED
              : "Couldn't start editing. Try again.",
        );
      }
    } catch {
      setError("Couldn't connect. Try again.");
    } finally {
      if (!minted) setBusy(false);
    }
  };

  const describedBy = error ? errorId : undefined;

  if (!asking) {
    return (
      <>
        <noscript dangerouslySetInnerHTML={{ __html: NO_SCRIPT_HTML }} />
        <div data-share-name-dialog className="brain-share-name">
          <Button variant="quiet" type="button" onClick={() => setAsking(true)}>
            Edit this page
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <noscript dangerouslySetInnerHTML={{ __html: NO_SCRIPT_HTML }} />
      <form data-share-name-dialog onSubmit={submit} className="brain-share-name">
      <p className="text-caption text-ink-3">
        Add your name and you can edit. You can read the page without one.
      </p>
      <div className="brain-share-name-fields">
        <div className="brain-share-name-field">
          <label htmlFor={nameId} className="text-table font-medium text-ink">
            Your name
          </label>
          <Field
            id={nameId}
            name="name"
            autoComplete="name"
            maxLength={VISITOR_NAME_MAX}
            value={name}
            aria-describedby={describedBy}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {askPassword && (
          <div className="brain-share-name-field">
            <label
              htmlFor={passwordId}
              className="text-table font-medium text-ink"
            >
              Password
            </label>
            <Field
              autoFocus
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={error === WRONG_PASSWORD || undefined}
              aria-describedby={describedBy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        )}
      </div>
      {error && (
        <p
          id={errorId}
          role="alert"
          aria-live="assertive"
          className="text-caption text-red"
        >
          {error}
        </p>
      )}
      <Button variant="ink" type="submit" disabled={busy || !ready}>
        {busy ? "Starting…" : "Start editing"}
      </Button>
      </form>
    </>
  );
}
