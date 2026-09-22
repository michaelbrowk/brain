import { redirect } from "next/navigation";
import { Shell } from "@/components/shell";
import { readModules } from "@/lib/owner-settings";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function MailPage() {
  const [store, modules] = await Promise.all([getStore(), readModules()]);
  // A bookmark, a reauth toast's href, a link somebody sent themselves. Home
  // rather than a 404: the module is off, not missing, and the switch that
  // brings it back is two rows away in Settings.
  if (!modules.mail) redirect("/");
  return (
    <Shell
      tree={store.getTree()}
      initialSelectedId={null}
      initialSurface="mail"
      modules={modules}
    />
  );
}
