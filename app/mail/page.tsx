import { Shell } from "@/components/shell";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function MailPage() {
  const store = await getStore();
  return <Shell tree={store.getTree()} initialSelectedId={null} initialSurface="mail" />;
}
