"use client";

import { useId, useState } from "react";
import { normalizeVisitorName, VISITOR_NAME_MAX } from "@/lib/sharing";
import { Button } from "./ui/button";
import { Field } from "./ui/field";

const WRONG_PASSWORD = "Wrong password";
const NEEDS_PASSWORD = "Enter the password to edit.";
// The owner closed editing, or the link expired, while this page was open.
// Trying again cannot fix that, so the message does not ask for it.
const CLOSED = "This page is no longer open for editing.";

/** Asked once per edit cookie, before the first edit. It belongs to the server
 *  render beside the password gate, so it appears without an editor bundle:
 *  the mint happens first and the island arrives on the reload after it.
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

  return (
    <form data-share-name-dialog onSubmit={submit} className="brain-share-name">
      <div>
        <h2 className="text-subheading text-ink">Who is editing?</h2>
        <p className="mt-1 text-caption text-ink-3">
          Your name shows on the pages you edit.
        </p>
      </div>
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
  );
}
