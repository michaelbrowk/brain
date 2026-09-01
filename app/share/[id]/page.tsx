import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { getStore } from "@/lib/store";
import { renderReadOnly } from "@/lib/render-md";
import { unreferencedDirectChildren } from "@/lib/derived-page-refs";
import {
  resolveShareAccess,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import { ShareGate } from "@/components/share-gate";
import { Icon } from "@/components/ui/icon";
import "@/components/editor/milkdown.css";

export const dynamic = "force-dynamic";

const DEFAULT_PUBLIC_ORIGIN = "https://brain.example.com";

function publicOrigin(): string {
  const configured = process.env.BRAIN_PUBLIC_ORIGIN?.trim();
  if (!configured) return DEFAULT_PUBLIC_ORIGIN;
  try {
    const url = new URL(configured);
    return url.origin === configured ? configured : DEFAULT_PUBLIC_ORIGIN;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

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
  let access;
  try {
    const jar = await cookies();
    access = await resolveShareAccess(store, {
      rootId: id,
      targetId,
      token: jar.get(`brain_share_${id}`)?.value,
      allowPasswordGate: true,
    });
  } catch (error) {
    if (!(error instanceof ShareAccessNotFoundError)) throw error;
    notFound();
  }
  if (access.kind === "password-required") return <ShareGate id={id} />;
  const page = access.target;

  const html = renderReadOnly(page.markdown, {
    attachmentAccess: {
      ...(targetId === id
        ? { pageId: id }
        : { rootId: id, targetId }),
      shareVersion: access.shareVersion,
    },
    shareNavigation: {
      rootId: id,
      isAllowedPage: (pageId) =>
        store.isWithinSubtree(id, pageId) && !store.isDeleted(pageId),
    },
  });
  const directChildren = unreferencedDirectChildren(
    access.directChildren,
    page.markdown,
    publicOrigin(),
  );
  const shareRootHref = `/share/${encodeURIComponent(id)}`;

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
            href={`/share/${encodeURIComponent(id)}`}
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
        {/* reuse the editor typography for a faithful read-only render */}
        <div className="milkdown">
          <div
            className="ProseMirror brain-read-only"
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
                  href={`${shareRootHref}?page=${encodeURIComponent(child.id)}`}
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
