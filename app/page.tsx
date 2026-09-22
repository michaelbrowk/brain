import { getStore } from "@/lib/store";
import { readModules } from "@/lib/owner-settings";
import { Shell } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const [store, modules] = await Promise.all([getStore(), readModules()]);
  return <Shell tree={store.getTree()} initialSelectedId={null} modules={modules} />;
}
