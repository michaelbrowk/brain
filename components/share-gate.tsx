"use client";

import { useState } from "react";
import { Icon } from "./ui/icon";

/** Password prompt on a protected shared page. On success the server sets a
 *  page-scoped cookie and a reload renders the content. */
export function ShareGate({ id }: { id: string }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    let opened = false;
    try {
      const res = await fetch("/api/share-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password }),
      });
      if (res.ok) {
        opened = true;
        location.reload();
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts. Wait a bit."
          : res.status === 401
            ? "Wrong password"
            : "Couldn't open this page. Try again.",
      );
      if (res.status === 401) setPassword("");
    } catch {
      setError("Couldn't connect. Try again.");
    } finally {
      if (!opened) setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh place-items-center bg-paper px-6 pb-[12dvh]">
      <div className="w-full max-w-[320px] text-center">
        <div className="mx-auto mb-5 grid size-12 place-items-center rounded-full bg-fill-hover">
          <Icon name="lock-keyhole-minimalistic-linear" size={20} className="text-ink-2" />
        </div>
        <h1 className="text-[17px] font-semibold text-ink">This page is protected</h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Enter the password to read it.
        </p>
        <form onSubmit={submit} className="mt-5">
          <input
            autoFocus
            type="password"
            aria-label="Page password"
            aria-invalid={!!error}
            aria-describedby={error ? `share-error-${id}` : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="h-11 w-full appearance-none rounded-lg border border-line bg-surface px-3 text-center text-[14px] text-ink outline-none placeholder:text-ink-3"
          />
          {error && (
            <p
              id={`share-error-${id}`}
              role="alert"
              aria-live="assertive"
              className="mt-2 text-[12px] text-ink-2"
            >
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={!password || busy}
            className="mt-3 h-11 w-full rounded-lg bg-ink text-[14px] font-medium text-paper transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            {busy ? "Checking…" : "Open"}
          </button>
        </form>
      </div>
    </div>
  );
}
