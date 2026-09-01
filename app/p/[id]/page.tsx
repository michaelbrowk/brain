import { notFound } from "next/navigation";
import { getStore, isNotFound, redactPage } from "@/lib/store";
import { Shell, type ShellInitialPage } from "@/components/shell";

export const dynamic = "force-dynamic";

/** Deep link to a page: /p/<id> — the shell opens with it selected. The body
 *  is read here too, so the first paint is content rather than a skeleton
 *  waiting on a client GET. */
export default async function PageRoute({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const store = await getStore();
  try {
    store.resolve(id);
  } catch {
    notFound();
  }
  let initialPage: ShellInitialPage | undefined;
  try {
    // Only the fields the canvas paints — the same subset the client GET
    // consumes — cross into the HTML payload.
    const { meta, markdown, rev } = redactPage(await store.readPage(id));
    initialPage = {
      id,
      meta: {
        title: meta.title,
        icon: meta.icon,
        cover: meta.cover,
        stickers: meta.stickers,
      },
      markdown,
      rev,
    };
  } catch (e) {
    if (isNotFound(e)) notFound();
    // Any other read failure leaves the seed empty: the client load effect
    // fetches as before and owns the retry state.
  }
  return (
    <Shell
      tree={store.getTree()}
      initialSelectedId={id}
      initialPage={initialPage}
    />
  );
}
