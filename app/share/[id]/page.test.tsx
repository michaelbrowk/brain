import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const root = {
  meta: {
    id: "root",
    title: "Root",
    public: true,
    shareVersion: 7,
  },
  markdown: "[Child](/p/child)",
  rev: "root-rev",
};
const child = {
  meta: {
    id: "child",
    title: "Child",
    icon: "📄",
  },
  markdown: "![](/_attachments-v2/abcdef123456.png)",
  rev: "child-rev",
};

async function loadPage(
  access:
    | {
        kind: "granted";
        root: typeof root;
        target: typeof child;
        shareVersion: number;
        directChildren?: Array<{ id: string; title: string; icon?: string }>;
      }
    | {
        kind: "password-required";
        root: typeof root;
        shareVersion: number;
      },
) {
  const resolvedAccess =
    access.kind === "granted"
      ? { ...access, directChildren: access.directChildren ?? [] }
      : access;
  const resolveShareAccess = vi.fn().mockResolvedValue(resolvedAccess);
  const renderReadOnly = vi.fn().mockReturnValue("<p>rendered</p>");
  const store = {
    isWithinSubtree: vi.fn().mockReturnValue(true),
    isDeleted: vi.fn().mockReturnValue(false),
  };
  vi.doMock("@/lib/store", () => ({ getStore: async () => store }));
  vi.doMock("@/lib/share-access", () => ({
    resolveShareAccess,
    ShareAccessNotFoundError: class extends Error {},
  }));
  vi.doMock("@/lib/render-md", () => ({ renderReadOnly }));
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        name === "brain_share_root" ? { value: "root-cookie" } : undefined,
    }),
  }));
  vi.doMock("next/navigation", () => ({
    notFound: () => {
      throw new Error("not found");
    },
  }));
  const pageModule = await import("./page");
  return { ...pageModule, resolveShareAccess, renderReadOnly, store };
}

describe("shared subtree page", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/share-access");
    vi.doUnmock("@/lib/render-md");
    vi.doUnmock("next/headers");
    vi.doUnmock("next/navigation");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("renders a descendant through the root share and scopes its media", async () => {
    const {
      default: SharePage,
      resolveShareAccess,
      renderReadOnly,
    } = await loadPage({
      kind: "granted",
      root,
      target: child,
      shareVersion: 7,
    });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({ page: "child" }),
    });

    const articleChildren = result.props.children.props.children as Array<{
      type?: string;
      props?: {
        children?: unknown;
        href?: string;
        className?: string;
        "aria-label"?: string;
      };
    }>;
    expect(
      articleChildren.find((node) => node?.type === "h1")?.props?.children,
    ).toBe("Child");
    const backLink = articleChildren.find((node) => node?.type === "a");
    expect(backLink?.props).toMatchObject({
      href: "/share/root",
      "aria-label": "Back to Root",
      className: expect.stringContaining("brain-touch-hit"),
    });
    const backLinkChildren = backLink?.props?.children as Array<{
      props?: { name?: string; size?: number; children?: unknown; className?: string };
    }>;
    expect(backLinkChildren[0]?.props).toMatchObject({
      name: "alt-arrow-left-linear",
      size: 14,
    });
    expect(backLinkChildren[1]?.props).toMatchObject({
      children: "Root",
      className: expect.stringContaining("truncate"),
    });
    const markup = renderToStaticMarkup(result);
    expect(markup).toContain("<svg");
    expect(markup).not.toContain("←");
    expect(resolveShareAccess).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        rootId: "root",
        targetId: "child",
        token: "root-cookie",
      }),
    );
    expect(renderReadOnly).toHaveBeenCalledWith(
      child.markdown,
      expect.objectContaining({
        attachmentAccess: {
          rootId: "root",
          targetId: "child",
          shareVersion: 7,
        },
      }),
    );
  });

  it("renders unreferenced direct children inside the authorized share", async () => {
    const { default: SharePage } = await loadPage({
      kind: "granted",
      root,
      target: root as unknown as typeof child,
      shareVersion: 7,
      directChildren: [
        { id: "child", title: "Child", icon: "📄" },
        { id: "derived", title: "<Derived>", icon: "🧭" },
      ],
    });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(result);

    expect(markup).toContain('data-derived-page-refs="true"');
    expect(markup).toContain('data-page-ref="derived"');
    expect(markup).toContain('href="/share/root?page=derived"');
    // icon in its own span, title escaped — textContent stays "🧭 <Derived>"
    expect(markup).toContain(
      '<span class="brain-page-ref-icon">🧭</span> &lt;Derived&gt;',
    );
    expect(markup).not.toContain('data-page-ref="child"');
  });

  it("keeps the password gate bound to the root id", async () => {
    const { default: SharePage } = await loadPage({
      kind: "password-required",
      root,
      shareVersion: 7,
    });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({ page: "child" }),
    });

    expect(result.props.id).toBe("root");
  });

  it("uses the descendant title only after access is granted", async () => {
    const { generateMetadata } = await loadPage({
      kind: "granted",
      root,
      target: child,
      shareVersion: 7,
    });

    await expect(
      generateMetadata({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "child" }),
      }),
    ).resolves.toEqual({
      title: "Child",
      description: "Shared from Brain",
    });
  });

  it("rejects a duplicate page query instead of falling back to the root", async () => {
    const { default: SharePage, resolveShareAccess } = await loadPage({
      kind: "granted",
      root,
      target: child,
      shareVersion: 7,
    });

    await expect(
      SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: ["child", "root"] }),
      }),
    ).rejects.toThrow("not found");
    expect(resolveShareAccess).not.toHaveBeenCalled();
  });
});
