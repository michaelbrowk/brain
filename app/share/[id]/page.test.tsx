import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const root = {
  meta: {
    id: "root",
    title: "Root",
    public: true,
    shareVersion: 7,
    /** A link with no end of its own, which is the ordinary case. One that
     *  does end is the `shareExpiresAt` case under "an app page behind a
     *  link": a frame token may not outlive the share it was cut from. */
    shareExpiresAt: undefined as string | undefined,
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
    /** The root that absorbed this link's page, as the resolver answers. */
    foldedInto?: string | null;
    /** The live title and icon the share may show for a page id. An id that
     *  is not here is one the share does not reach. */
    labels?: Record<string, { title: string; icon?: string }>;
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
    readShareNode: vi.fn().mockReturnValue(null),
  };
  const resolveShareLabels = vi.fn(
    (_store: unknown, _rootId: string, ids: Iterable<string>) => {
      const labels = new Map<string, { title: string; icon?: string }>();
      for (const id of ids) {
        const label = options.labels?.[id];
        if (label) labels.set(id, label);
      }
      return labels;
    },
  );
  const verifyShareEditToken = vi.fn().mockResolvedValue(options.editing ?? null);
  const mount = vi.fn((props: Record<string, unknown>) => (
    <div data-share-editor-mount={JSON.stringify(props)} />
  ));
  const appFrame = vi.fn((props: Record<string, unknown>) => (
    <div data-share-app-frame={JSON.stringify(props)} />
  ));
  const mintAppFrameToken = vi.fn().mockResolvedValue("minted.frame.token");
  vi.doMock("@/lib/apps/frame-token", () => ({
    mintAppFrameToken,
    APP_FRAME_TOKEN_MAX_AGE_SECONDS: 12 * 60 * 60,
  }));
  vi.doMock("@/lib/store", () => ({
    getStore: async () => store,
    configuredPublicOrigin: () =>
      options.origin === undefined ? "https://brain.example.com" : options.origin,
  }));
  const resolveFoldedShareRoot = vi
    .fn()
    .mockReturnValue(options.foldedInto ?? null);
  vi.doMock("@/lib/share-access", () => ({
    resolveShareAccess,
    resolveFoldedShareRoot,
    resolveShareLabels,
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
  vi.doMock("@/components/apps/share-app-frame", () => ({
    ShareAppFrame: appFrame,
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
    permanentRedirect: (url: string) => {
      throw Object.assign(new Error("redirect"), { url });
    },
  }));
  const pageModule = await import("./page");
  return {
    ...pageModule,
    resolveShareAccess,
    resolveFoldedShareRoot,
    resolveShareLabels,
    renderReadOnly,
    store,
    verifyShareEditToken,
    mount,
    appFrame,
    mintAppFrameToken,
  };
}

describe("shared subtree page", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/share-access");
    vi.doUnmock("@/lib/render-md");
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/components/editor/share-editor-mount");
    vi.doUnmock("@/components/apps/share-app-frame");
    vi.doUnmock("@/lib/apps/frame-token");
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

  it("gives the read-only render the live title of every ref the share reaches", async () => {
    const {
      default: SharePage,
      renderReadOnly,
      resolveShareLabels,
    } = await loadPage(
      {
        kind: "granted",
        root: { ...root, markdown: "[📄 Untitled](/p/child)" },
        target: root as unknown as typeof child,
        shareVersion: 7,
      },
      { labels: { child: { title: "Pantry", icon: "🥫" } } },
    );

    await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });

    expect(resolveShareLabels).toHaveBeenCalledWith(
      expect.anything(),
      "root",
      ["child"],
    );
    const { shareNavigation } = renderReadOnly.mock.calls[0]![1] as {
      shareNavigation: {
        pageLabel: (id: string) => { title: string; icon?: string } | null;
      };
    };
    expect(shareNavigation.pageLabel("child")).toEqual({
      title: "Pantry",
      icon: "🥫",
    });
    // A page the share does not reach has no live label, so its written
    // label stands and the visitor learns nothing about it.
    expect(shareNavigation.pageLabel("elsewhere")).toBeNull();
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

  it("classifies links against the configured origin only, never an invented one, and still lists subpages without one", async () => {
    const noOriginRoot = {
      ...root,
      markdown:
        "[Child](/p/child)\n\n[Derived](https://brain.example.com/p/derived)",
    };
    const { default: SharePage } = await loadPage(
      {
        kind: "granted",
        root: noOriginRoot,
        target: noOriginRoot as unknown as typeof child,
        shareVersion: 7,
        directChildren: [
          { id: "child", title: "Child", icon: "📄" },
          { id: "derived", title: "Derived", icon: "🧭" },
        ],
      },
      { origin: null },
    );

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(result);

    // The relative form means the same thing on every host, so the child it
    // names is linked already and stays out of the derived list.
    expect(markup).not.toContain('data-page-ref="child"');
    // The absolute one is not a page link: there is no origin to compare it
    // to, and the default this used to fall back to was an origin nobody
    // configured.
    expect(markup).toContain('data-derived-page-refs="true"');
    expect(markup).toContain('data-page-ref="derived"');
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
      // A link pasted into a chat is a card, and the card used to carry the
      // title and nothing else: no source, no kind, nothing saying where the
      // page came from. `robots` stays where it is, on the response headers:
      // a shared page is still not for a crawler.
      openGraph: { title: "Child", siteName: "Brain", type: "article" },
      twitter: { card: "summary", title: "Child" },
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

  it("answers a busy store with a retry it can stop, never a 500", async () => {
    const { default: SharePage } = await loadPage({ kind: "busy" });

    const result = await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });
    const markup = renderToStaticMarkup(result);

    expect(markup).toContain("data-share-busy");
    // A refresh every second cannot be stopped and reloads under a screen
    // reader mid-sentence. The retry counts down where it can be seen and
    // stopped, and the page keeps a link a browser with no scripts can press.
    expect(markup).not.toContain("http-equiv=\"refresh\"");
    expect(markup).toContain("data-share-busy-countdown");
    expect(markup).toContain("Stop");
    expect(markup).toContain("This page is busy. It will come back in a moment.");
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
      // One control, not a form: a reader who only wants to read is asked
      // nothing.
      expect(markup).toContain("Edit this page");
      expect(markup).not.toContain("Your name");
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
          labels: { child: { title: "Pantry", icon: "🥫" } },
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
        // The name the mint took, so the island can say it back: nothing
        // else confirms it was accepted.
        visitorName: "Ann",
        initialMarkdown: editableRoot.markdown,
        initialRev: "root-rev",
        // Only the linked pages the share reaches, each with the title and
        // icon it carries now rather than the one the body was written with:
        // the island renders a ref to any other page as unavailable, the way
        // the read-only page flattens it.
        linkablePages: [{ id: "child", title: "Pantry", icon: "🥫" }],
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

  describe("an app page behind a link", () => {
    const trainer = {
      meta: { id: "app1", title: "Trainer", icon: "🃏", kind: "app" as const },
      markdown: "A trainer for the Spanish words on these pages.",
      rev: "app-rev",
    };

    it("runs the app in place of the body it would have drawn", async () => {
      const { default: SharePage, appFrame } = await loadPage({
        kind: "granted",
        root,
        target: trainer as unknown as typeof child,
        shareVersion: 7,
      });

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "app1" }),
      });
      const markup = renderToStaticMarkup(result);

      expect(appFrame).toHaveBeenCalledTimes(1);
      expect(appFrame.mock.calls[0]![0]).toEqual({
        appId: "app1",
        rootId: "root",
        shareVersion: 7,
        src: "/api/app/app1/t/minted.frame.token/index.html",
        title: "Trainer",
      });
      // The title block and the back link are the page's, not the app's, and
      // they stay exactly where a shared page draws them.
      expect(markup).toContain("Trainer");
      expect(markup).toContain("/share/root");
      // Spec §2: a client that cannot run the app reads the agent's own
      // description of it. The server always draws it, and the island is the
      // sibling that hides it.
      expect(markup).toContain('data-share-fallback="true"');
      expect(markup).toContain("<p>rendered</p>");
    });

    it("cuts the frame's key from the grant it just resolved", async () => {
      // The version is the resolver's own, never one read separately: the
      // route asks the live share for exactly that version, so a rotation
      // makes every token cut before it a 404 without anything expiring.
      const { default: SharePage, mintAppFrameToken } = await loadPage({
        kind: "granted",
        root,
        target: trainer as unknown as typeof child,
        shareVersion: 7,
      });
      const before = Math.floor(Date.now() / 1000);

      await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "app1" }),
      });

      expect(mintAppFrameToken).toHaveBeenCalledTimes(1);
      const minted = mintAppFrameToken.mock.calls[0]![0] as {
        pageId: string;
        grant: { kind: string; root: string; version: number };
        exp: number;
      };
      expect(minted.pageId).toBe("app1");
      expect(minted.grant).toEqual({ kind: "share", root: "root", version: 7 });
      // The owner's window, because this root carries no expiry of its own.
      expect(minted.exp).toBeGreaterThanOrEqual(before + 12 * 60 * 60);
      expect(minted.exp).toBeLessThanOrEqual(before + 12 * 60 * 60 + 5);
    });

    it("cuts a key that dies with the link rather than on the clock", async () => {
      // A share that ends this afternoon does not hand out a key good until
      // tomorrow morning. `exp` is the sooner of the two, always.
      const endsSoon = new Date(Date.now() + 60_000).toISOString();
      const { default: SharePage, mintAppFrameToken } = await loadPage({
        kind: "granted",
        root: { ...root, meta: { ...root.meta, shareExpiresAt: endsSoon } },
        target: trainer as unknown as typeof child,
        shareVersion: 7,
      });

      await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "app1" }),
      });

      const minted = mintAppFrameToken.mock.calls[0]![0] as { exp: number };
      expect(minted.exp).toBe(Math.floor(Date.parse(endsSoon) / 1000));
    });

    it("mints nothing for a locked link until the password is proven", async () => {
      // The gate returns before the mint, which is the whole of it: a token
      // is a bearer capability, and cutting one for somebody who has not
      // shown the password would hand them the app's files through a route
      // that reads no cookie and could not tell the difference.
      const { default: SharePage, mintAppFrameToken, appFrame } = await loadPage({
        kind: "password-required",
        root,
        shareVersion: 7,
      });

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "app1" }),
      });

      expect(mintAppFrameToken).not.toHaveBeenCalled();
      expect(appFrame).not.toHaveBeenCalled();
      expect(renderToStaticMarkup(result)).not.toContain("/api/app/");
    });

    it("cuts nothing at all for a page that is not an app", async () => {
      const { default: SharePage, mintAppFrameToken } = await loadPage({
        kind: "granted",
        root,
        target: child,
        shareVersion: 7,
      });

      await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "child" }),
      });

      expect(mintAppFrameToken).not.toHaveBeenCalled();
    });

    it("does not make an app editable because the share is", async () => {
      // An editable share is a licence to write Markdown, and an app's body
      // is not what a visitor would be writing. The editor island is never
      // mounted over one, and the name dialog that precedes it is not asked
      // for either.
      const editableRoot = {
        ...root,
        meta: { ...root.meta, shareEdit: true },
      };
      const { default: SharePage, appFrame, mount, verifyShareEditToken } =
        await loadPage(
          {
            kind: "granted",
            root: editableRoot,
            target: trainer as unknown as typeof child,
            shareVersion: 7,
          },
          { editing: { vid: "vid-1", name: "Ann" } },
        );

      const result = await SharePage({
        params: Promise.resolve({ id: "root" }),
        searchParams: Promise.resolve({ page: "app1" }),
      });
      const markup = renderToStaticMarkup(result);

      expect(appFrame).toHaveBeenCalledTimes(1);
      expect(mount).not.toHaveBeenCalled();
      expect(verifyShareEditToken).not.toHaveBeenCalled();
      expect(markup).not.toContain("data-share-editor-mount");
      expect(markup).not.toContain("data-share-name-dialog");
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

  it("sends a folded page's old address to the root that absorbed it", async () => {
    const {
      default: SharePage,
      resolveShareAccess,
      resolveFoldedShareRoot,
      store,
    } = await loadPage(
      { kind: "granted", root, target: child, shareVersion: 7 },
      { foldedInto: "apartment" },
    );

    await expect(
      SharePage({
        params: Promise.resolve({ id: "furniture" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toMatchObject({ url: "/share/apartment?page=furniture" });
    // the subpage form of the old address keeps its page
    await expect(
      SharePage({
        params: Promise.resolve({ id: "furniture" }),
        searchParams: Promise.resolve({ page: "sofa" }),
      }),
    ).rejects.toMatchObject({ url: "/share/apartment?page=sofa" });
    expect(resolveFoldedShareRoot).toHaveBeenCalledWith(store, "furniture");
    // the hop happens before any grant is read, so the refused root never
    // reaches the access check
    expect(resolveShareAccess).not.toHaveBeenCalled();
  });

  it("leaves an unfolded address where it is", async () => {
    const { default: SharePage, resolveShareAccess } = await loadPage({
      kind: "granted",
      root,
      target: child,
      shareVersion: 7,
    });

    await SharePage({
      params: Promise.resolve({ id: "root" }),
      searchParams: Promise.resolve({}),
    });

    expect(resolveShareAccess).toHaveBeenCalledTimes(1);
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
