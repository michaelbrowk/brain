"use client";

// Mail: hosts the code-split account manager. The chunk load shows the same
// skeleton the manager uses while fetching, so the section paints once.
// `initialAccountId` is the /settings/mail?account=<id> deep link — the
// manager opens that account's details when it exists.

import dynamic from "next/dynamic";
import { MailSettingsSkeleton } from "../mail-settings-skeleton";

const MailAccountSettings = dynamic(
  () =>
    import("../mail-account-settings").then((m) => m.MailAccountSettings),
  { ssr: false, loading: () => <MailSettingsSkeleton /> },
);

export function MailSection({
  onOpenMail,
  onAccountStatusChange,
  onToast,
  initialAccountId,
}: {
  onOpenMail: () => void;
  onAccountStatusChange?: (configured: boolean) => void;
  onToast: (title: string) => void;
  initialAccountId?: string | null;
}) {
  return (
    <MailAccountSettings
      onOpenMail={onOpenMail}
      onAccountStatusChange={onAccountStatusChange}
      onToast={onToast}
      initialAccountId={initialAccountId}
    />
  );
}
