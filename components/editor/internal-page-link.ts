import {
  classifyInternalPageLink,
  INTERNAL_PAGE_LINK_CLASS,
} from "@/lib/internal-page-link";

export {
  classifyInternalPageLink,
  INTERNAL_PAGE_LINK_CLASS,
} from "@/lib/internal-page-link";
export type { InternalPageLink } from "@/lib/internal-page-link";

export type EditorLinkNavigation =
  | { kind: "internal"; id: string }
  | { kind: "external"; href: string };

const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//;

export function classifyEditorLinkNavigation(
  rawHref: string | null | undefined,
  currentOrigin: string,
): EditorLinkNavigation | null {
  const internal = classifyInternalPageLink(rawHref, currentOrigin);
  if (internal) return { kind: "internal", id: internal.id };
  if (!rawHref || rawHref !== rawHref.trim()) return null;

  let base: URL;
  try {
    base = new URL(currentOrigin);
  } catch {
    return null;
  }
  if (base.origin !== currentOrigin) return null;

  let url: URL;
  try {
    if (rawHref.startsWith("/")) {
      if (rawHref.startsWith("//")) return null;
      url = new URL(rawHref, base);
    } else {
      if (!ABSOLUTE_HTTP_URL_RE.test(rawHref)) return null;
      url = new URL(rawHref);
    }
  } catch {
    return null;
  }
  if (url.username || url.password) return null;

  return { kind: "external", href: url.href };
}

export function followEditorLink(
  rawHref: string | null | undefined,
  currentOrigin: string,
  navigateInternal: ((id: string) => void) | undefined,
  openExternal: (href: string) => void,
): boolean {
  const navigation = classifyEditorLinkNavigation(rawHref, currentOrigin);
  if (!navigation) return false;
  if (navigation.kind === "internal") {
    if (!navigateInternal) return false;
    navigateInternal(navigation.id);
  } else {
    openExternal(navigation.href);
  }
  return true;
}

/** A click on an anchor inside the editor. A page ref goes by its id and
 *  never by its href: the owner's shell moves to the page, a link visitor's
 *  island moves within the share, and the href, which only the display
 *  decides, is never what a click reads. A ref with no href is one the editor
 *  could not place, and nothing happens. Every other anchor goes through its
 *  href, resolved first (a bare attachment path becomes the URL the browser
 *  may fetch). Returns whether the click was taken. */
export function followEditorAnchor(
  anchor: HTMLAnchorElement,
  currentOrigin: string,
  navigateInternal: ((id: string) => void) | undefined,
  openExternal: (href: string) => void,
  resolveHref: (href: string) => string = (href) => href,
): boolean {
  const pageRefId = anchor.dataset.pageRef;
  if (pageRefId !== undefined) {
    if (!navigateInternal || !anchor.hasAttribute("href")) return false;
    navigateInternal(pageRefId);
    return true;
  }
  const href = anchor.getAttribute("href");
  return followEditorLink(
    href === null ? null : resolveHref(href),
    currentOrigin,
    navigateInternal,
    openExternal,
  );
}

function syncMarker(anchor: HTMLAnchorElement, currentOrigin: string) {
  const internal =
    !anchor.classList.contains("brain-page-ref") &&
    classifyInternalPageLink(anchor.getAttribute("href"), currentOrigin) !== null;
  anchor.classList.toggle(INTERNAL_PAGE_LINK_CLASS, internal);
}

function syncNode(node: Node, currentOrigin: string) {
  if (!(node instanceof Element)) return;
  if (node instanceof HTMLAnchorElement) syncMarker(node, currentOrigin);
  node
    .querySelectorAll<HTMLAnchorElement>("a")
    .forEach((anchor) => syncMarker(anchor, currentOrigin));
}

/**
 * Keep internal-link styling in sync with ProseMirror's live DOM. Milkdown can
 * reuse an anchor node and change its href, so a one-time scan is insufficient.
 */
export function observeInternalPageLinks(
  root: Element,
  currentOrigin: string,
): () => void {
  syncNode(root, currentOrigin);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLAnchorElement) {
          syncMarker(record.target, currentOrigin);
        }
        continue;
      }
      record.addedNodes.forEach((node) => syncNode(node, currentOrigin));
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["href", "class"],
  });
  return () => observer.disconnect();
}
