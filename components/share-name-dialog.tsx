"use client";

import { useState } from "react";
import { VISITOR_NAME_MAX } from "@/lib/sharing";
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
 *  On a locked root the visitor reached this page through the gate, and the
 *  mint accepts that read cookie in place of the password. So the password
 *  field is not drawn until the mint says the cookie no longer counts (it
 *  expired, or the share was re-issued since the page loaded): a control
 *  lives exactly as long as its reason. */
export function ShareNameDialog({
  id,
  locked,
  onMinted = () => location.reload(),
}: {
  id: string;
  locked: boolean;
  onMinted?: () => void;
}) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [askPassword, setAskPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
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
          ...(locked && password ? { password } : {}),
        }),
      });
      if (res.ok) {
        minted = true;
        onMinted();
        return;
      }
      if (res.status === 401 && locked) {
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

  return (
    <form data-share-name-dialog onSubmit={submit} className="brain-share-name">
      <div>
        <h2 className="text-subheading text-ink">Who is editing?</h2>
        <p className="mt-1 text-caption text-ink-3">
          Your name shows on the pages you edit.
        </p>
      </div>
      <div className="brain-share-name-fields">
        <Field
          aria-label="Your name"
          name="name"
          autoComplete="name"
          placeholder="Your name"
          value={name}
          maxLength={VISITOR_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
        />
        {locked && askPassword && (
          <Field
            autoFocus
            aria-label="Password"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            aria-invalid={error === WRONG_PASSWORD || undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        )}
      </div>
      {error && (
        <p role="alert" className="text-caption text-red">
          {error}
        </p>
      )}
      <Button variant="ink" type="submit" disabled={busy || !name.trim()}>
        {busy ? "Starting…" : "Start editing"}
      </Button>
    </form>
  );
}
