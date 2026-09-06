import { describe, expect, it } from "vitest";
import {
  linkDestinations,
  linkSchemeAllowed,
  remoteMediaReference,
  remoteMediaReferences,
  unsafeLinkDestination,
} from "./link-schemes";

describe("linkSchemeAllowed", () => {
  it("allows a relative destination, which is every link the app writes itself", () => {
    for (const href of [
      "/p/abc123",
      "/_attachments-v2/aBcDeF012345.png",
      "#heading",
      "./sibling",
      "",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(true);
    }
  });

  it("allows http, https and mailto", () => {
    for (const href of [
      "https://brain.test/x",
      "http://brain.test/x",
      "HTTPS://brain.test/x",
      "mailto:ada@brain.test",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(true);
    }
  });

  it("refuses every other scheme", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "blob:https://brain.test/x",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(false);
    }
  });

  it("refuses a scheme hidden behind whitespace or a control character", () => {
    for (const href of [
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "\u0001javascript:alert(1)",
      "jav\u0000ascript:alert(1)",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(false);
    }
  });

  it("refuses a scheme hidden behind a character reference", () => {
    // A CommonMark parser decodes character references in a link
    // destination, so what marked hands over raw is what remark hands the
    // owner's editor decoded.
    for (const href of [
      "javascript&#58;alert(1)",
      "javascript&colon;alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6a;avascript:alert(1)",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(false);
    }
  });

  it("does not read a query string as a character reference", () => {
    expect(linkSchemeAllowed("https://brain.test/x?a=1&b=2&copy=3")).toBe(true);
  });
});

describe("unsafeLinkDestination", () => {
  it("finds the destination in a link, an image, a reference link and an autolink", () => {
    expect(unsafeLinkDestination("[x](javascript:alert(1))")).toBe(
      "javascript:alert(1)",
    );
    expect(unsafeLinkDestination("![x](data:text/html,y)")).toBe(
      "data:text/html,y",
    );
    expect(
      unsafeLinkDestination("[x][ref]\n\n[ref]: javascript:alert(1)"),
    ).toBe("javascript:alert(1)");
    expect(unsafeLinkDestination("<javascript:alert(1)>")).toBe(
      "javascript:alert(1)",
    );
  });

  it("returns null for a body whose destinations are all allowed", () => {
    expect(
      unsafeLinkDestination(
        "# Title\n\n[a](/p/abc) and ![b](/_attachments-v2/aBcDeF012345.png) and [c](https://brain.test)",
      ),
    ).toBeNull();
  });

  it("ignores a scheme that is only prose or fenced code", () => {
    expect(
      unsafeLinkDestination(
        "Write javascript:alert(1) in a note.\n\n```\n[x](javascript:alert(1))\n```\n",
      ),
    ).toBeNull();
  });

  it("looks inside the editor's container directives, the way the renderer does", () => {
    expect(
      unsafeLinkDestination(":::callout{kind=note}\n[x](javascript:alert(1))\n:::"),
    ).toBe("javascript:alert(1)");
  });

  it("leaves a destination the page already held alone", () => {
    const held = linkDestinations("[x](javascript:alert(1))");
    expect(held.has("javascript:alert(1)")).toBe(true);
    expect(
      unsafeLinkDestination("[x](javascript:alert(1)) and more text", held),
    ).toBeNull();
    expect(
      unsafeLinkDestination("[x](javascript:alert(2))", held),
    ).toBe("javascript:alert(2)");
  });
});

describe("remoteMediaReference", () => {
  it("refuses a Markdown image on another site, however it is spelled", () => {
    for (const href of [
      "https://evil.test/x.png",
      "http://evil.test/x.png",
      "//evil.test/x.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "HTTPS://evil.test/x.png",
    ]) {
      expect(remoteMediaReference(`![](${href})`), href).toBe(href);
    }
  });

  it("takes a local image, which is the only kind a visitor has a way to add", () => {
    expect(
      remoteMediaReference(
        "![](/_attachments-v2/aBcDeF012345.png) and ![](/api/media/aBcDeF012345.png)",
      ),
    ).toBeNull();
  });

  it("leaves a link to another site alone, because a link is not a fetch", () => {
    expect(remoteMediaReference("[read this](https://example.test/page)")).toBeNull();
  });

  it("refuses raw HTML that names a subresource on another site", () => {
    for (const html of [
      '<img src="https://evil.test/x.png">',
      '<video src="https://evil.test/v.mp4"></video>',
      '<audio src="https://evil.test/a.mp3"></audio>',
      '<picture><source srcset="https://evil.test/s.png"></picture>',
      '<table background="https://evil.test/t.png"><tr><td>x</td></tr></table>',
      '<svg><image href="https://evil.test/s.svg"/></svg>',
      "<img src=//evil.test/x.png>",
      '<img src="https&#58;//evil.test/x.png">',
    ]) {
      expect(remoteMediaReference(html), html).not.toBeNull();
    }
  });

  it("takes raw HTML that stays on this origin", () => {
    expect(
      remoteMediaReference('<img src="/_attachments-v2/aBcDeF012345.png">'),
    ).toBeNull();
  });

  it("ignores a URL that is only prose or fenced code", () => {
    expect(
      remoteMediaReference(
        "Paste https://evil.test/x.png here.\n\n```\n![](https://evil.test/x.png)\n```\n",
      ),
    ).toBeNull();
  });

  it("leaves a reference the page already held alone", () => {
    const body = "![](https://evil.test/x.png)";
    const held = remoteMediaReferences(body);
    expect(remoteMediaReference(`${body}\n\nplus a caption`, held)).toBeNull();
    expect(remoteMediaReference("![](https://evil.test/y.png)", held)).toBe(
      "https://evil.test/y.png",
    );
  });
});

describe("a backslash where the authority starts", () => {
  // A browser reads a backslash as a forward slash in the authority position,
  // and `new URL` agrees: "/\\host", "\\\\host" and "\\/host" all resolve to
  // "//host" and fetch cross-origin. Neither surface the owner reads carries
  // an img-src, so the write path is the only thing standing here.
  const BS = String.fromCharCode(92);

  it("refuses the raw-HTML spellings, which reach the history preview verbatim", () => {
    for (const src of [
      "/" + BS + "evil.test/x.gif",
      BS + BS + "evil.test/x.gif",
      BS + "/evil.test/x.gif",
    ]) {
      expect(remoteMediaReference(`<img src="${src}">`), src).toBe(src);
    }
  });

  it("refuses the Markdown spelling CommonMark leaves alone", () => {
    // Only this one survives the tokenizer as written: "\\e" is not an escape,
    // because `e` is not ASCII punctuation.
    const href = "/" + BS + "evil.test/x.gif";
    expect(remoteMediaReference(`![](${href})`)).toBe(href);
  });

  it("is not fooled by a character reference standing in for the backslash", () => {
    // The history preview emits the entity into HTML, where the parser decodes
    // it back to a backslash before the fetch.
    const href = "/&#92;evil.test/x.gif";
    expect(remoteMediaReference(`![](${href})`)).toBe(href);
    expect(remoteMediaReference(`<img src="${href}">`)).toBe(href);
  });

  it("refuses a third slash, which resolves cross-origin the same way", () => {
    expect(remoteMediaReference("![](///evil.test/x.gif)")).toBe(
      "///evil.test/x.gif",
    );
  });

  it("leaves a reference that stays on this origin alone", () => {
    // One leading backslash is a path, not an authority: `new URL` resolves
    // it against the page. Folding it to a forward slash keeps it a path, so
    // normalizing costs a legitimate reference nothing.
    for (const src of [
      BS + "evil.test/x.gif",
      "/_attachments-v2/a" + BS + "b.png",
      "/_attachments-v2/aBcDeF012345.png",
    ]) {
      expect(remoteMediaReference(`<img src="${src}">`), src).toBeNull();
    }
  });

  it("changes no verdict on the scheme test, where a slash cannot start one", () => {
    // Folding can never create a scheme, because `/` is not a scheme
    // character, and it ends a match exactly where the backslash already did.
    for (const href of [
      "/" + BS + "evil.test/x.gif",
      BS + BS + "evil.test/x.gif",
      "https://brain.test/a" + BS + "b",
    ]) {
      expect(linkSchemeAllowed(href), href).toBe(true);
    }
    expect(linkSchemeAllowed("java" + BS + "script:alert(1)")).toBe(true);
    expect(linkSchemeAllowed("javascript:alert(1)")).toBe(false);
  });
});
