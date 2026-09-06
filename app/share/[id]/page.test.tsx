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

class ShareAccessNotFoundError extends Error {}
class ShareAccessBusyError extends Error {}

type Granted = {
  kind: "granted";
  root: typeof root;
  target: typeof child;
  shareVersion: number;
  directChildren?: Array<{ id: string; title: string; icon?: string }>;
};
type PasswordRequired = {
  kind: "password-required";
  root: typeof root;
  shareVersion: number;
};

async function loadPage(
  access: Granted | PasswordRequired | { kind: "busy" },
  options: {
    /** What the edit cookie verifies to; the cookie itself is on the jar
     *  only when this is set. */
    editing?: { vid: string; name: string } | null;
    origin?: string | null;
    withinSubtree?: (rootId: string, pageId: string) => boolean;
  } = {},
) {
  const resolveShareAccess = vi.fn();
  if (access.kind === "busy") {
    resolveShareAccess.mockRejectedValue(new ShareAccessBusyError());
  } else {
    resolveShareAccess.mockResolvedValue(
      access.kind === "granted"
        ? { ...access, directChildren: access.directChildren ?? [] }
        : access,
    );
  }
  const renderReadOnly = vi.fn().mockReturnValue("<p>rendered</p>");
  const store = {
    isWithinSubtree: vi.fn(options.withinSubtree ?? (() => true)),
    isDeleted: vi.fn().mockReturnValue(false),
  };
  const verifyShareEditToken = vi.fn().mockResolvedValue(options.editing ?? null);
  const mount = vi.fn((props: Record<string, unknown>) => (
    <div data-share-editor-mount={JSON.stringify(props)} />
  ));
  vi.doMock("@/lib/store", () => ({
    getStore: async () => store,
    configuredPublicOrigin: () =>
      options.origin === undefined ? "https://brain.example.com" : options.origin,
  }));
  vi.doMock("@/lib/share-access", () => ({
    resolveShareAccess,
    ShareAccessNotFoundError,
    ShareAccessBusyError,
  }));
  vi.doMock("@/lib/render-md", () => ({ renderReadOnly }));
  vi.doMock("@/lib/auth", () => ({
    verifyShareEditToken,
    shareEditCookieName: (rootId: string) => `brain_edit_share_${rootId}`,
  }));
  vi.doMock("@/components/editor/share-editor-mount", () => ({
    ShareEditorMount: mount,
  }));
  vi.doMock("next/headers", () => ({
    cookies: async () => ({
      get: (name: string) =>
        name === "brain_share_root"
          ? { value: "root-cookie" }
          : name === "brain_edit_share_root" && options.editing
            ? { value: "edit-cookie" }
            : undefined,
    }),
  }));
  vi.doMock("next/navigation", () => ({
    notFound: () => {
      throw new Error("not found");
    },
  }));
  const pageModule = await import("./page");
  return {
    ...pageModule,
    resolveShareAccess,
    renderReadOnly,
    store,
    verifyShareEditToken,
    mount,
  };
}

describe("shared subtree page", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/share-access");
    vi.doUnmock("@/lib/render-md");
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/components/editor/share-editor-mount");
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

  it("classifies links against the configured origin only, never an invented one", async () => {
    const { default: SharePage } = await loadPage(
      {
        kind: "granted",
        root,
        target: root as unknown as typeof child,
        shareVersion: 7,
        directChildren: [{ id: "derived", title: "Derived", icon: "🧭" }],
      },
      { origin: null },
    );

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(result);

    expect(markup).not.toContain("data-derived-page-refs");
    expect(markup).not.toContain("brain.example.com");
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

  it("answers a busy store with a one-second self-refresh, never a 500", async () => {
    const { default: SharePage } = await loadPage({ kind: "busy" });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(result);

    expect(markup).toContain("data-share-busy");
    expect(markup).toMatch(/<meta http-equiv="refresh" content="1"\/?>/);
    expect(markup).toContain("This page is busy. It will come back in a moment.");
    // A refresh the reader cannot stop is not a way out, so the page carries
    // one: the same address, pressable now.
    expect(markup).toContain("data-share-busy-retry");
    expect(markup).toContain('href="/share/root"');
    expect(markup).toContain("Try now");
    expect(markup).not.toContain("data-share-name-dialog");
  });

  it("points the busy page's own link at the page that was asked for", async () => {
    const { default: SharePage } = await loadPage({ kind: "busy" });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({ page: "child" }),
    });

    expect(renderToStaticMarkup(result)).toContain(
      'href="/share/root?page=child"',
    );
  });

  describe("an editable share", () => {
    const editableRoot = {
      ...root,
      meta: { ...root.meta, shareEdit: true },
      markdown: "[Child](/p/child)\n\n[Elsewhere](/p/elsewhere)",
    };

    it("asks for a name above the read-only render when there is no edit cookie", async () => {
      const {
        default: SharePage,
        verifyShareEditToken,
        mount,
      } = await loadPage({
        kind: "granted",
        root: editableRoot,
        target: editableRoot as unknown as typeof child,
        shareVersion: 7,
      });

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({}),
      });
      const markup = renderToStaticMarkup(result);

      expect(verifyShareEditToken).toHaveBeenCalledWith(undefined, "root", 7);
      expect(markup).toContain("data-share-name-dialog");
      expect(markup).toContain("Who is editing?");
      expect(markup).toContain("<p>rendered</p>");
      expect(findDialog(result)?.props).toEqual({ id: "root" });
      expect(mount).not.toHaveBeenCalled();
    });

    it("mounts the island over the read-only render for a valid edit cookie", async () => {
      const {
        default: SharePage,
        verifyShareEditToken,
        mount,
      } = await loadPage(
        {
          kind: "granted",
          root: editableRoot,
          target: editableRoot as unknown as typeof child,
          shareVersion: 7,
        },
        {
          editing: { vid: "vid-1", name: "Ann" },
          withinSubtree: (_rootId, pageId) => pageId !== "elsewhere",
        },
      );

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({}),
      });
      const markup = renderToStaticMarkup(result);

      expect(verifyShareEditToken).toHaveBeenCalledWith("edit-cookie", "root", 7);
      expect(mount).toHaveBeenCalledTimes(1);
      expect(mount.mock.calls[0]![0]).toEqual({
        rootId: "root",
        pageId: "root",
        shareVersion: 7,
        vid: "vid-1",
        initialMarkdown: editableRoot.markdown,
        initialRev: "root-rev",
        // Only the linked pages the share reaches: the island renders a ref
        // to any other page as unavailable, the way the read-only page
        // flattens it.
        linkablePageIds: ["child"],
      });
      expect(markup).toContain("data-share-editor-mount");
      // The read-only render stays underneath: a script-blocked browser and
      // the moment before the chunk arrives both see the page as it is. The
      // marker is what app/globals.css reads to drop it once the island is a
      // sibling of it in the DOM.
      expect(markup).toContain('data-share-fallback="true"');
      expect(markup).toContain("<p>rendered</p>");
      expect(markup).not.toContain("data-share-name-dialog");
    });

    it("asks a locked root for a name the same way, and no password", async () => {
      // The visitor came through the gate, so the read cookie stands in for
      // the password and the server has nothing extra to ask. Whether the
      // mint still accepts that cookie is the mint's answer, not the page's,
      // so the dialog is handed the same one prop either way.
      const lockedRoot = {
        ...editableRoot,
        meta: { ...editableRoot.meta, sharePass: "$2a$10$hash" },
      };
      const { default: SharePage } = await loadPage({
        kind: "granted",
        root: lockedRoot,
        target: lockedRoot as unknown as typeof child,
        shareVersion: 7,
      });

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({}),
      });
      expect(findDialog(result)?.props).toEqual({ id: "root" });
      expect(renderToStaticMarkup(result)).not.toContain("Password");
    });
  });

  it("offers nothing on a read-only share", async () => {
    const {
      default: SharePage,
      verifyShareEditToken,
      mount,
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
    const markup = renderToStaticMarkup(result);

    expect(verifyShareEditToken).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(markup).not.toContain("data-share-name-dialog");
    expect(markup).not.toContain("data-share-fallback");
    expect(markup).toContain("<p>rendered</p>");
  });
});

/** The name dialog element inside the rendered tree, found by its component
 *  name so the props it was given can be read directly. */
function findDialog(node: unknown): { props: Record<string, unknown> } | null {
  if (!node || typeof node !== "object") return null;
  const element = node as {
    type?: { name?: string };
    props?: { children?: unknown } & Record<string, unknown>;
  };
  if (element.type?.name === "ShareNameDialog") {
    return element as { props: Record<string, unknown> };
  }
  const children = element.props?.children;
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    const found = findDialog(child);
    if (found) return found;
  }
  return null;
}
