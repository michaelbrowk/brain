import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";

type UnfurlMeta = {
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  favicon?: string;
  url?: string;
};

const linkPreviewKey = new PluginKey("brainLinkPreview");
const previewCache = new Map<string, UnfurlMeta | null>();
const previewInflight = new Map<string, Promise<UnfurlMeta | null>>();

function hostnameLabel(rawUrl: string) {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return rawUrl;
  }
}

function isInternalPageUrl(url: URL) {
  if (!/^\/p\/[\w-]+/.test(url.pathname)) return false;
  if (typeof window === "undefined" || !window.location.host) return false;
  return url.host === window.location.host;
}

function externalHttpUrl(href: unknown) {
  if (typeof href !== "string") return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (isInternalPageUrl(url)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function sameUrlText(text: string, href: string) {
  const visible = text.trim();
  if (!visible || visible !== text) return false;
  if (visible === href) return true;
  return visible.replace(/\/$/, "") === href.replace(/\/$/, "");
}

function bareExternalLink(node: ProseNode) {
  if (node.type.name !== "paragraph" || node.childCount !== 1) return null;

  const child = node.child(0);
  if (!child.isText) return null;

  const link = child.marks.find((mark) => mark.type.name === "link");
  const href = typeof link?.attrs.href === "string" ? link.attrs.href : "";
  const url = externalHttpUrl(href);
  if (!url || !sameUrlText(child.text ?? "", href)) return null;

  return url;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function image(url: string, className: string) {
  const img = document.createElement("img");
  img.className = className;
  img.src = url;
  img.alt = "";
  img.loading = "lazy";
  img.decoding = "async";
  img.referrerPolicy = "no-referrer";
  img.addEventListener("error", () => {
    img.hidden = true;
  });
  return img;
}

function renderSkeleton(card: HTMLAnchorElement) {
  card.className = "brain-embed brain-embed-loading";

  const body = el("span", "brain-embed-body");
  const site = el("span", "brain-embed-site");
  site.append(el("span", "brain-embed-skeleton brain-embed-skeleton-icon"));
  site.append(el("span", "brain-embed-skeleton brain-embed-skeleton-site"));
  body.append(site);
  body.append(el("span", "brain-embed-skeleton brain-embed-skeleton-title"));
  body.append(el("span", "brain-embed-skeleton brain-embed-skeleton-desc"));

  const thumb = el("span", "brain-embed-skeleton brain-embed-skeleton-thumb");
  card.replaceChildren(body, thumb);
}

function renderFallback(card: HTMLAnchorElement, url: string) {
  card.className = "brain-embed brain-embed-fallback";
  card.textContent = url;
}

function shouldFallback(meta: UnfurlMeta | null, url: string) {
  if (!meta) return true;
  const host = hostnameLabel(url);
  const title = (meta.title ?? "").trim();
  return !meta.description && !meta.image && !meta.siteName && !meta.favicon && (!title || title === host);
}

function renderCard(card: HTMLAnchorElement, url: string, meta: UnfurlMeta) {
  if (shouldFallback(meta, url)) {
    renderFallback(card, url);
    return;
  }

  const resolvedUrl = meta.url || url;
  const host = hostnameLabel(resolvedUrl);
  const siteText = meta.siteName || host;
  const titleText = meta.title || host;

  card.className = "brain-embed";

  const body = el("span", "brain-embed-body");
  const site = el("span", "brain-embed-site");
  if (meta.favicon) site.append(image(meta.favicon, "brain-embed-favicon"));
  const siteName = el("span", "brain-embed-site-name");
  siteName.textContent = siteText;
  site.append(siteName);

  const title = el("span", "brain-embed-title");
  title.textContent = titleText;

  body.append(site, title);

  if (meta.description) {
    const description = el("span", "brain-embed-description");
    description.textContent = meta.description;
    body.append(description);
  }

  const nodes: HTMLElement[] = [body];
  if (meta.image) {
    const thumb = el("span", "brain-embed-thumb");
    thumb.append(image(meta.image, "brain-embed-thumb-image"));
    nodes.push(thumb);
  }

  card.replaceChildren(...nodes);
}

function loadPreview(url: string) {
  if (previewCache.has(url)) return Promise.resolve(previewCache.get(url) ?? null);

  const pending = previewInflight.get(url);
  if (pending) return pending;

  const promise = fetch(`/api/unfurl?url=${encodeURIComponent(url)}`)
    .then(async (res) => {
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as UnfurlMeta | null;
      if (!data || typeof data !== "object") return null;
      return data;
    })
    .catch(() => null)
    .then((data) => {
      previewInflight.delete(url);
      previewCache.set(url, data);
      return data;
    });

  previewInflight.set(url, promise);
  return promise;
}

function embedWidget(url: string) {
  const card = document.createElement("a");
  card.href = url;
  card.target = "_blank";
  card.rel = "noreferrer noopener";
  card.setAttribute("contenteditable", "false");
  card.setAttribute("aria-label", url);

  const cached = previewCache.get(url);
  if (cached !== undefined) {
    if (cached) renderCard(card, url, cached);
    else renderFallback(card, url);
  } else {
    renderSkeleton(card);
    void loadPreview(url).then((meta) => {
      if (!card.isConnected) return;
      if (meta) renderCard(card, url, meta);
      else renderFallback(card, url);
    });
  }

  return card;
}

function decorations(doc: ProseNode) {
  const found: Decoration[] = [];

  doc.descendants((node, pos) => {
    const url = bareExternalLink(node);
    if (!url) return;

    found.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: "brain-embed-source",
        "data-brain-embed-source": "true",
      }),
      Decoration.widget(pos + node.nodeSize, () => embedWidget(url), {
        key: `brain-embed:${pos}:${url}`,
        side: -1,
        stopEvent: (event) => event.type === "click" || event.type === "mousedown",
        ignoreSelection: true,
      }),
    );
  });

  return DecorationSet.create(doc, found);
}

export const linkPreview = $prose(
  () =>
    new Plugin({
      key: linkPreviewKey,
      props: {
        decorations: (state) => decorations(state.doc),
      },
    }),
);
