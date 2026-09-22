import { Shell } from "@/components/shell";
import { readModules } from "@/lib/owner-settings";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

/** /settings — the settings surface inside the shell. Mobile shows the root
 *  section list; desktop normalises to /settings/appearance on mount. */
export default async function SettingsPage() {
  const [store, modules] = await Promise.all([getStore(), readModules()]);
  return (
    <Shell
      tree={store.getTree()}
      initialSelectedId={null}
      initialSurface="settings"
      modules={modules}
    />
  );
}
