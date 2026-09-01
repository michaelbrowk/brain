import { getStore } from "@/lib/store";
import { Shell } from "@/components/shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const store = await getStore();
  return <Shell tree={store.getTree()} initialSelectedId={null} />;
}
