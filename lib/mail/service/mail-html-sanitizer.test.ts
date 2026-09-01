import { describe, expect, it } from "vitest";

import {
  sanitizeMailHtml,
  sanitizeMailHtmlWithRemoteImages,
} from "./mail-html-sanitizer";

const BUDGET = Object.freeze({
  maxCharacters: 100_000,
  maxNodes: 1_000,
  maxAttributes: 4_000,
  maxRemoteImages: 32,
});

describe("mail HTML sanitizer", () => {
  it("drops document metadata instead of leaking the subject into the message body", () => {
    const sanitized = sanitizeMailHtml(
      [
        "<!doctype html><html><head>",
        "<title>3 animation rules you can apply today</title>",
        "<style>body{font-size:99px}</style>",
        "<template>Hidden template copy</template>",
        "</head><body>",
        '<div style="font-family:Inter,ui-sans-serif,sans-serif;font-size:16px;line-height:29px">',
        "People often think you need to have that thing.",
        "</div></body></html>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toBe(
      '<div style="font-family:Inter,ui-sans-serif,sans-serif;font-size:16px;line-height:29px">People often think you need to have that thing.</div>',
    );
    expect(sanitized).not.toMatch(
      /3 animation rules|font-size:99px|Hidden template copy/,
    );
  });

  it("keeps bounded newsletter layout styles without retaining network CSS", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<table width="100%" cellpadding="12" cellspacing="0" bgcolor="#fff"',
        ' style="max-width:640px;margin:0 auto;border-collapse:collapse;',
        'background-image:url(https://tracker.test/pixel);position:fixed">',
        '<tr><td style="padding:16px;text-align:center;color:#222;font-size:16px">',
        "Newsletter",
        "</td></tr></table>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain('width="100%"');
    expect(sanitized).toContain('cellpadding="12"');
    expect(sanitized).toContain(
      'style="max-width:640px;margin:0 auto;border-collapse:collapse;background-color:#fff"',
    );
    expect(sanitized).toContain(
      'style="padding:16px;text-align:center;color:#222;font-size:16px"',
    );
    expect(sanitized).not.toMatch(/tracker|url\(|background-image|position/i);
  });

  it("keeps preheader hiding styles so preview text never renders as a column", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<div style="font-size:0;line-height:1px;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">',
        "Preview copy meant for the inbox list only",
        "</div>",
        '<div style="visibility:hidden;overflow-x:auto;overflow-y:scroll;opacity:.5">Half</div>',
        '<span style="opacity:50%;overflow:clip">Percent</span>',
        '<p style="opacity:2;opacity:-1;opacity:1e3;opacity:url(https://evil.test);overflow:inherit;overflow:url(https://evil.test);visibility:initial;overflow-x:hidden url(https://evil.test)">Rejected</p>',
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain(
      '<div style="font-size:0;line-height:1px;color:transparent;max-height:0;max-width:0;opacity:0;overflow:hidden">',
    );
    expect(sanitized).toContain(
      '<div style="visibility:hidden;overflow-x:auto;overflow-y:scroll;opacity:.5">Half</div>',
    );
    expect(sanitized).toContain(
      '<span style="opacity:50%;overflow:clip">Percent</span>',
    );
    expect(sanitized).toContain("<p>Rejected</p>");
    expect(sanitized).not.toMatch(/mso-hide|inherit|initial|evil|url\(/);
  });

  it("keeps hidden tracking images suppressed after the hiding styles became allowed", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img style="opacity:0" src="https://hidden.example.test/opacity.png" alt="Opacity pixel">',
        '<img style="visibility:hidden" src="https://hidden.example.test/visibility.png" alt="Visibility pixel">',
        '<img style="overflow:hidden;width:1px;height:1px" src="https://hidden.example.test/overflow.png" alt="Overflow pixel">',
        '<div style="overflow:hidden;width:0"><img width="600" height="400" src="https://visible.example.test/clipped-layout.png" alt="Clipped layout"></div>',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://visible.example.test/clipped-layout.png",
      },
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(1);
    expect(result.html).toContain('<div style="overflow:hidden;width:0">');
    expect(result.html).toContain("Opacity pixel");
    expect(result.html).toContain("Visibility pixel");
    expect(result.html).toContain("Overflow pixel");
    expect(result.html).not.toMatch(/https:\/\/|hidden\.example|visible\.example/);
  });

  it("keeps inline email tables on one row", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<table style="display:inline-table;float:none;width:32px">',
        '<tr><td><img src="cid:social@example.test" alt="Social"></td></tr>',
        "</table>",
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain(
      'style="display:inline-table;float:none;width:32px"',
    );
  });

  it("removes active content, remote loads, forms, and obfuscated CSS", () => {
    const sanitized = sanitizeMailHtml(
      [
        '<script>fetch("https://evil.test")</script>',
        '<form action="https://evil.test"><input name="secret"><p>Visible copy</p></form>',
        '<img src="https://tracker.test/pixel" alt="remote">',
        '<img src="cid:logo@example.test" onerror="steal()"',
        ' style="width:120px;background:u\\72l(https://evil.test)">',
        '<a href="javascript:steal()" ping="https://tracker.test">bad</a>',
      ].join(""),
      BUDGET,
    );

    expect(sanitized).toContain("Visible copy");
    expect(sanitized).toContain("remote");
    expect(sanitized).toContain(
      '<img data-brain-cid="logo@example.test" alt="" style="width:120px">',
    );
    expect(sanitized).not.toMatch(
      /script|form|input|onerror|javascript:|https:\/\/|ping=|u\\72l/i,
    );
  });

  it("separates HTTPS image URLs from opaque iframe identifiers", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img src="https://images.example.test/banner.png?campaign=one#fragment" alt="Banner">',
        '<img src="https://images.example.test/banner.png?campaign=one" alt="Again">',
        '<img src="//cdn.example.test/photo.jpg" alt="Photo">',
        '<img src="https://user:secret@images.example.test/credential.png" alt="Credential">',
        '<img src="http://images.example.test/plain.png" alt="Plain">',
        '<img src="https://127.0.0.1/internal.png" alt="Internal">',
        '<img src="https://localhost/local.png" alt="Local">',
        '<img src="https://tracker.example.test/open.gif" width="1" height="1" alt="Pixel">',
        '<img src="https://tracker.example.test/css.gif" style="width:1px;height:1px" alt="CSS Pixel">',
        '<img src="https://tracker.example.test/hidden.gif" style="display:none" alt="Hidden">',
      ].join(""),
      { ...BUDGET, maxRemoteImages: 2 },
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://images.example.test/banner.png?campaign=one",
      },
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}2`,
        sourceUrl: "https://cdn.example.test/photo.jpg",
      },
    ]);
    expect(result.html).toContain(
      `data-brain-remote-image="remote-image-a${"0".repeat(31)}1"`,
    );
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(3);
    expect(result.html).toContain("Credential");
    expect(result.html).toContain("Plain");
    expect(result.html).toContain("Internal");
    expect(result.html).toContain("Local");
    expect(result.html).toContain("Pixel");
    expect(result.html).toContain("CSS Pixel");
    expect(result.html).toContain("Hidden");
    expect(result.html).not.toMatch(
      /images\.example|cdn\.example|tracker\.example|127\.0\.0\.1|localhost|secret/,
    );
  });

  it("does not allocate remote images hidden by their own or ancestor attributes and styles", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img hidden src="https://hidden.example.test/own-hidden.png" alt="Own hidden">',
        '<img aria-hidden=" TRUE " src="https://hidden.example.test/own-aria.png" alt="Own aria">',
        '<div hidden><img width="600" height="400" src="https://hidden.example.test/ancestor-hidden.png" alt="Ancestor hidden"></div>',
        '<section aria-hidden="true"><img src="https://hidden.example.test/unknown-ancestor.png" alt="Unknown ancestor"></section>',
        '<div style="DISPLAY:/**/none ! important"><img src="https://hidden.example.test/display.png" alt="Display hidden"></div>',
        '<div style="visibility:hidden"><img src="https://hidden.example.test/visibility.png" alt="Visibility hidden"></div>',
        '<div style="visibility:collapse"><img src="https://hidden.example.test/collapse.png" alt="Visibility collapse"></div>',
        '<div style="content-visibility: hidden"><img src="https://hidden.example.test/content-visibility.png" alt="Content hidden"></div>',
        '<div style="opacity:.0"><img src="https://hidden.example.test/opacity-number.png" alt="Opacity number"></div>',
        '<div style="opacity:0%"><img src="https://hidden.example.test/opacity-percent.png" alt="Opacity percent"></div>',
        '<div hidden><wbr><img src="https://hidden.example.test/after-void.png" alt="After void hidden"></div>',
        '<img src="https://visible.example.test/after-hidden.png" alt="Visible after hidden">',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages).toEqual([
      {
        remoteImageId: `remote-image-a${"0".repeat(31)}1`,
        sourceUrl: "https://visible.example.test/after-hidden.png",
      },
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(1);
    expect(result.html).toContain("Visible after hidden");
    expect(result.html).not.toMatch(
      /https:\/\/|hidden\.example|visible\.example|own-hidden|own-aria|ancestor-hidden|unknown-ancestor|opacity-number/,
    );
  });

  it("does not allocate remote images constrained to tracking-pixel dimensions", () => {
    let sequence = 0;
    const result = sanitizeMailHtmlWithRemoteImages(
      [
        '<img width="2" height="1" src="https://pixel.example.test/attributes.gif" alt="Attribute pixel">',
        '<img style="width:0;height:auto" src="https://pixel.example.test/zero-width.gif" alt="Zero width">',
        '<img style="height:0;width:auto" src="https://pixel.example.test/zero-height.gif" alt="Zero height">',
        '<img style="max-width:0" src="https://pixel.example.test/zero-max-width.gif" alt="Zero maximum width">',
        '<img style="width:0%" src="https://pixel.example.test/zero-percent.gif" alt="Zero percent width">',
        '<img style="max-height:0rem" src="https://pixel.example.test/zero-rem.gif" alt="Zero rem height">',
        '<img width="1" src="https://pixel.example.test/implicit-height.gif" alt="Implicit small height">',
        '<img style="width:1px;height:auto" src="https://pixel.example.test/auto-height.gif" alt="Automatic small height">',
        '<img style="max-width:1px" src="https://pixel.example.test/implicit-max-height.gif" alt="Implicit maximum height">',
        '<img height="1" src="https://pixel.example.test/implicit-width.gif" alt="Implicit small width">',
        '<img style="height:1px;width:auto" src="https://pixel.example.test/auto-width.gif" alt="Automatic small width">',
        '<img style="max-height:1px" src="https://pixel.example.test/implicit-max-width.gif" alt="Implicit maximum width">',
        '<img style="max-width:1px;max-height:2px" src="https://pixel.example.test/max-size.gif" alt="Maximum pixel">',
        '<img width="600" style="max-width:2px;height:1px" src="https://pixel.example.test/mixed-size.gif" alt="Mixed pixel">',
        '<div style="width:2px;max-height:2px"><img width="600" height="400" src="https://pixel.example.test/allowed-ancestor.gif" alt="Allowed ancestor pixel"></div>',
        '<section width="1px" style="max-height:.5px"><img src="https://pixel.example.test/unknown-ancestor.gif" alt="Unknown ancestor pixel"></section>',
        '<div style="max-width:1px;max-height:1px"><br><wbr><img src="https://pixel.example.test/after-void.gif" alt="Void pixel"></div>',
        '<table><tr><th style="width:600px;height:0"><img width="600" src="https://visible.example.test/zero-height-layout.png" alt="Visible zero-height layout"></th></tr></table>',
        '<img style="max-width:1px;height:400px" src="https://visible.example.test/one-small-axis.png" alt="One small axis">',
        '<img width="3" height="2" src="https://visible.example.test/three-by-two.png" alt="Three by two">',
        '<img style="width:1px;width:600px;height:1px;height:400px" src="https://visible.example.test/overridden.png" alt="Overridden size">',
        '<img style="width:600px!important;width:1px;height:400px!important;height:1px" src="https://visible.example.test/important.png" alt="Important visible size">',
        '<img style="width:600px;width:1px!important;height:400px;height:1px!important" src="https://pixel.example.test/important-small.gif" alt="Important small size">',
        '<img src="https://visible.example.test/after-small-ancestor.png" alt="Visible after small ancestor">',
      ].join(""),
      BUDGET,
      () => `remote-image-a${String(++sequence).padStart(32, "0")}`,
    );

    expect(result.remoteImages.map(({ sourceUrl }) => sourceUrl)).toEqual([
      "https://visible.example.test/zero-height-layout.png",
      "https://visible.example.test/one-small-axis.png",
      "https://visible.example.test/three-by-two.png",
      "https://visible.example.test/overridden.png",
      "https://visible.example.test/important.png",
      "https://visible.example.test/after-small-ancestor.png",
    ]);
    expect(result.html?.match(/data-brain-remote-image=/g)).toHaveLength(6);
    expect(result.html).toContain("style=\"width:600px;height:400px\"");
    expect(result.html).toContain("Visible after small ancestor");
    expect(result.html).not.toMatch(
      /https:\/\/|pixel\.example|visible\.example|attributes\.gif|max-size\.gif|mixed-size\.gif|unknown-ancestor\.gif/,
    );
  });
});
