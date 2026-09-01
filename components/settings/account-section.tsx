"use client";

// Account: session controls. "Log out everywhere" bumps the session epoch —
// it signs out every browser and device, including this one, and asks for a
// second press before firing.

import { useState } from "react";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow } from "./shared";

export function AccountSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [logoutArmed, setLogoutArmed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  return (
    <div className="space-y-7">
      <SettingsGroup title="Sessions">
        <SettingsRow
          label="Log out everywhere"
          hint="Signs out every browser and device, including this one. Share links and connected apps stay untouched"
        >
          <Button
            variant="destructive"
            disabled={loggingOut}
            onClick={() => {
              if (!logoutArmed) {
                setLogoutArmed(true);
                // arm expires on its own — no effect-driven reset
                window.setTimeout(
                  () => setLogoutArmed(false),
                  4000,
                );
                return;
              }
              setLoggingOut(true);
              void (async () => {
                try {
                  const response = await fetch("/api/auth", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ scope: "everywhere" }),
                  });
                  if (!response.ok) throw new Error();
                  window.location.assign("/login");
                } catch {
                  setLoggingOut(false);
                  setLogoutArmed(false);
                  onToast?.("Could not log out everywhere");
                }
              })();
            }}
          >
            {loggingOut
              ? "Logging out…"
              : logoutArmed
                ? "Confirm log out"
                : "Log out everywhere"}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    </div>
  );
}
