import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { configuredPublicOrigin, getStore } from "@/lib/store";
import { renderReadOnly } from "@/lib/render-md";
import {
  referencedPageIds,
  unreferencedDirectChildren,
} from "@/lib/derived-page-refs";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { shareEditCookieName, verifyShareEditToken } from "@/lib/auth";
import { ShareGate } from "@/components/share-gate";
import { ShareBusyRetry } from "@/components/share-busy-retry";
import { ShareNameDialog } from "@/components/share-name-dialog";
import { ShareEditorMount } from "@/components/editor/share-editor-mount";
import { Icon } from "@/components/ui/icon";
import "@/components/editor/milkdown.css";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (Array.isArray(query.page)) return { title: "Brain" };
  const targetId = query.page ?? id;
  try {
    const store = await getStore();
    const access = await resolveShareAccess(store, {
      rootId: id,
      targetId,
      allowPasswordGate: true,
    });
    if (access.kind !== "granted") return { title: "Brain" };
    return {
      title: access.target.meta.title,
      description: "Shared from Brain",
    };
  } catch {
    return { title: "Brain" };
  }
}

export default async function SharePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string | string[] }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  if (Array.isArray(query.page)) notFound();
  const targetId = query.page ?? id;
  const store = await getStore();
  const jar = await cookies();
  let access;
  try {
    access = await resolveShareAccess(store, {
      rootId: id,
      targetId,
      token: jar.get(`brain_share_${id}`)?.value,
      allowPasswordGate: true,
    });
  } catch (error) {
    if (error instanceof ShareAccessNotFoundError) notFound();
    // The honest answer is 503 with Retry-After: 1, and every route handler
    // gives it. A Server Component cannot set a status — notFound() is the only
    // one Next exposes — so rather than a 500 page, a shared page that is busy
    // says so and comes back by itself in a second.
    if (error instanceof ShareAccessBusyError) {
      return <ShareBusy href={sharePageHref(id, targetId)} />;
    }
    throw error;
  }
  if (access.kind === "password-required") return <ShareGate id={id} />;
  const page = access.target;

  // The edit cookie is root-scoped and bound to the share version, so it
  // answers for every page of the share and dies with every rotation.
  const editable = access.root.meta.shareEdit === true;
  const editing = editable
    ? await verifyShareEditToken(
        jar.get(shareEditCookieName(id))?.value,
        id,
        access.shareVersion,
      )
    : null;
  const needsName = editable && !editing;

  const isAllowedPage = (pageId: string) =>
    store.isWithinSubtree(id, pageId) && !store.isDeleted(pageId);
  const html = renderReadOnly(page.markdown, {
    attachmentAccess: {
      ...(targetId === id
        ? { pageId: id }
        : { rootId: id, targetId }),
      shareVersion: access.shareVersion,
    },
    shareNavigation: { rootId: id, isAllowedPage },
  });
  const origin = configuredPublicOrigin();
  const directChildren = unreferencedDirectChildren(
    access.directChildren,
    page.markdown,
    origin,
  );
  // What the island may link: the pages this body links today that the share
  // reaches, by the rule the read-only render applies to the same links. The
  // island cannot ask the store, so a ref pasted later stays unavailable until
  // the next load, which is the side the guard errs on too.
  const linkablePageIds = editing
    ? [...referencedPageIds(page.markdown, origin)].filter(isAllowedPage)
    : [];
  const shareRootHref = sharePageHref(id, id);

  return (
    <div className="min-h-dvh bg-paper">
      <article
        data-page-font={page.meta.font}
        data-small-text={page.meta.smallText ? "true" : undefined}
        data-full-width={page.meta.fullWidth ? "true" : undefined}
        className={`brain-page-article mx-auto px-5 pt-14 pb-24 md:px-6 ${
          page.meta.fullWidth ? "w-full max-w-[1440px] md:px-10" : "max-w-[720px]"
        }`}
      >
        {targetId !== id && (
          <a
            href={shareRootHref}
            data-share-root-link
            aria-label={`Back to ${access.root.meta.title}`}
            className="brain-touch-hit mb-7 inline-flex min-w-0 max-w-full items-center gap-1 rounded-sm text-[12px] text-ink-3 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line"
          >
            <Icon
              name="alt-arrow-left-linear"
              size={14}
              className="shrink-0"
            />
            <span className="min-w-0 truncate">{access.root.meta.title}</span>
          </a>
        )}
        {page.meta.icon && (
          <div className="mb-5 text-[40px] leading-none">{page.meta.icon}</div>
        )}
        <h1
          className="mb-10 text-[28px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink md:text-[30px]"
          style={{
            fontFamily: "var(--brain-page-headings, var(--font-headings))",
          }}
        >
          {page.meta.title}
        </h1>
        {needsName && <ShareNameDialog id={id} />}
        {/* reuse the editor typography for a faithful read-only render */}
        <div className="milkdown">
          {editing && (
            <ShareEditorMount
              rootId={id}
              pageId={page.meta.id}
              shareVersion={access.shareVersion}
              vid={editing.vid}
              visitorName={editing.name}
              initialMarkdown={page.markdown}
              initialRev={page.rev}
              linkablePageIds={linkablePageIds}
            />
          )}
          {/* Always drawn: the no-JS fallback a crawler and a script-blocked
              browser read, and the page as it stands until the island's chunk
              arrives, which hides it the moment it mounts. */}
          <div
            className="ProseMirror brain-read-only"
            data-share-fallback={editing ? "true" : undefined}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
        {directChildren.length > 0 && (
          <div data-derived-page-refs className="mt-3 min-w-0 max-w-full">
            {directChildren.map((child) => (
              <p
                key={child.id}
                className="brain-page-ref-only min-w-0 max-w-full"
              >
                <a
                  href={sharePageHref(id, child.id)}
                  data-page-ref={child.id}
                  className="brain-page-ref"
                >
                  <span className="brain-page-ref-icon">{child.icon || "📄"}</span>
                  {` ${child.title}`}
                </a>
              </p>
            ))}
          </div>
        )}
      </article>
    </div>
  );
}

/** The address of one page of a share, the one form both the read-only render
 *  and the visitor's island link to. */
function sharePageHref(rootId: string, pageId: string): string {
  const root = `/share/${encodeURIComponent(rootId)}`;
  return pageId === rootId ? root : `${root}?page=${encodeURIComponent(pageId)}`;
}

/** The busy interstitial. Retry-After: 1, expressed the only way a page can.
 *  The retry is an island rather than a meta refresh: a refresh every second
 *  cannot be stopped and reloads under a screen reader before it has finished
 *  the sentence. The link stays for a browser running no scripts, and for a
 *  reader who does not want to wait at all. */
function ShareBusy({ href }: { href: string }) {
  return (
    <div
      data-share-busy
      className="grid min-h-dvh place-items-center bg-paper px-6 pb-[12dvh]"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-table text-ink-3">
          This page is busy. It will come back in a moment.
        </p>
        <ShareBusyRetry href={href} />
        <a
          href={href}
          data-share-busy-retry
          className="brain-touch-hit rounded-sm text-control text-ink-2 underline underline-offset-2 transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line"
        >
          Try now
        </a>
      </div>
    </div>
  );
}
