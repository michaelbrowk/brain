import { notFound } from "next/navigation";
import { Shell } from "@/components/shell";
import { isSettingsSection } from "@/components/settings/sections";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** /settings/[section] — a deep link straight into one settings section.
 *  `?account=<id>` on /settings/mail opens that account's details (the
 *  Mail reauth toasts link here). */
export default async function SettingsSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  const query = await searchParams;
  const account = typeof query.account === "string" ? query.account : null;
  const store = await getStore();
  return (
    <Shell
      tree={store.getTree()}
      initialSelectedId={null}
      initialSurface="settings"
      initialSettingsSection={section}
      initialMailSettingsAccountId={section === "mail" ? account : null}
    />
  );
}
