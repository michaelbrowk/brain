import { Shell } from "@/components/shell";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** /settings — the settings surface inside the shell. Mobile shows the root
 *  section list; desktop normalises to /settings/appearance on mount. */
export default async function SettingsPage() {
  const store = await getStore();
  return (
    <Shell
      tree={store.getTree()}
      initialSelectedId={null}
      initialSurface="settings"
    />
  );
}
