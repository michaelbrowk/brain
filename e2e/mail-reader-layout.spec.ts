// Layout regression for the sanitized reader frame, measured on the markup
// GitHub actually sends for a workflow run and on a reconstructed digest that
// holds the four ways bulk mail declares an image's size. The frame is built
// here through the real sanitizer and the real document builder, then rendered
// at reader widths and measured. Nothing is stubbed but the transport.
import { expect, test } from "playwright/test";

import { createMailHtmlDocument } from "../lib/mail/reader-html";
import { MAIL_RESOURCE_LIMITS } from "../lib/mail/security";
import {
  sanitizeMailHtml,
  sanitizeMailHtmlWithRemoteImages,
} from "../lib/mail/service/mail-html-sanitizer";
import {
  githubActionsRunEmailHtml,
  githubActionsRunEmailWithTokensHtml,
  declaredGeometryDigestEmailHtml,
  declaredGeometryDigestRaster,
  paddedHeroEmailHtml,
  WIDE_IMAGE_RASTERS,
  wideImageEmailHtml,
} from "../lib/mail/testing/reader-layout-fixtures";

const READER_WIDTHS = [360, 390, 560, 620] as const;

function readerDocument(emailHtml: string): string {
  const sanitized = sanitizeMailHtml(emailHtml, {
    maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
    maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
    maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
    maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
  });
  expect(sanitized).not.toBeNull();
  return createMailHtmlDocument({
    sanitizedHtml: sanitized ?? "",
    attachments: [],
    cidSources: new Map(),
  });
}

type CellMetrics = { readonly width: number; readonly lines: number };
type FrameMetrics = {
  readonly cells: Record<string, CellMetrics | null>;
  readonly spacerGapPx: number | null;
  readonly overflowX: string;
  readonly pannablePx: number;
  readonly heightSyncable: boolean;
};

async function measure(
  page: import("playwright/test").Page,
  documentHtml: string,
  width: number,
): Promise<FrameMetrics> {
  return page.evaluate(
    async ([html, frameWidth]) => {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.style.cssText = `border:0;width:${frameWidth}px;height:3000px;display:block`;
      frame.srcdoc = html as string;
      await new Promise<void>((resolve) => {
        frame.addEventListener("load", () => resolve(), { once: true });
        document.body.append(frame);
      });
      const frameDocument = frame.contentDocument!;
      const root = frameDocument.getElementById("brain-mail-content")!;
      const cells = [...frameDocument.querySelectorAll("td")];

      const lineCount = (cell: Element): number => {
        const walker = frameDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
        const tops = new Set<number>();
        let node: Node | null;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue?.trim()) continue;
          const range = frameDocument.createRange();
          range.selectNodeContents(node);
          for (const rect of range.getClientRects()) {
            if (rect.width > 0) tops.add(Math.round(rect.top));
          }
        }
        return tops.size;
      };

      const byExactText = (text: string) => {
        const cell = cells.find((candidate) => candidate.textContent?.trim() === text);
        return cell
          ? { width: Math.round(cell.getBoundingClientRect().width * 10) / 10, lines: lineCount(cell) }
          : null;
      };
      const innermostContaining = (text: string) => {
        const hits = cells.filter((candidate) => candidate.textContent?.includes(text));
        const cell = hits.find((candidate) => !hits.some((other) => other !== candidate && candidate.contains(other)));
        return cell
          ? { width: Math.round(cell.getBoundingClientRect().width * 10) / 10, lines: lineCount(cell) }
          : null;
      };

      const rerun = [...frameDocument.querySelectorAll("a")].find(
        (anchor) => anchor.textContent?.trim() === "Re-run",
      );
      const spacerGapPx = rerun
        ? Math.round(
            rerun.closest("table")!.getBoundingClientRect().right -
              rerun.getBoundingClientRect().right,
          )
        : null;

      const metrics = {
        cells: {
          statusHeader: byExactText("Status"),
          failedBadge: byExactText("Failed"),
          cancelledBadge: byExactText("Cancelled"),
          plainLabel: byExactText("Queued"),
          rightAligned: byExactText("14 min"),
          bareToken: innermostContaining("check_suite_focus"),
          linkToken: innermostContaining("anchor=deadbeefcafe"),
        },
        spacerGapPx,
        overflowX: getComputedStyle(root).overflowX,
        pannablePx: root.scrollWidth - root.clientWidth,
        heightSyncable: root.scrollHeight >= Math.floor(root.getBoundingClientRect().height),
      };
      frame.remove();
      return metrics;
    },
    [documentHtml, width] as const,
  );
}

test("@release a short mail table column never renders one glyph per line", async ({
page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocument(githubActionsRunEmailHtml);

  for (const width of READER_WIDTHS) {
    const metrics = await measure(page, documentHtml, width);
    const shortColumns = [
      "statusHeader",
      "failedBadge",
      "cancelledBadge",
      "plainLabel",
      "rightAligned",
    ] as const;

    for (const key of shortColumns) {
      const cell = metrics.cells[key];
      expect(cell, `${key} missing at ${width}px`).not.toBeNull();
      // The bug rendered these at ~18-32px across 5-6 lines. A column that
      // holds its longest word needs one line and roughly its text width.
      expect(
        cell!.lines,
        `${key} wrapped onto ${cell!.lines} lines at ${width}px`,
      ).toBe(1);
      expect(
        cell!.width,
        `${key} collapsed to ${cell!.width}px at ${width}px`,
      ).toBeGreaterThan(40);
    }
  }
});

test("@release an unbreakable token in a mail table stays reachable instead of clipped", async ({
page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocument(githubActionsRunEmailWithTokensHtml);

  for (const width of READER_WIDTHS) {
    const metrics = await measure(page, documentHtml, width);
    // A token with nothing to break on cannot fit and cannot be shredded to a
    // one-glyph column either. It widens the message, and the message pans.
    expect(metrics.overflowX, `overflow-x at ${width}px`).toBe("auto");
    expect(
      metrics.pannablePx,
      `nothing to pan to at ${width}px, so the token is clipped`,
    ).toBeGreaterThan(0);
    for (const key of ["bareToken", "linkToken"] as const) {
      const cell = metrics.cells[key];
      expect(cell, `${key} missing at ${width}px`).not.toBeNull();
      expect(
        cell!.width,
        `${key} shredded to ${cell!.width}px at ${width}px`,
      ).toBeGreaterThan(100);
    }
    expect(metrics.heightSyncable, `height sync broke at ${width}px`).toBe(true);
  }
});

test("@release the sender's spacer cell still pushes a button to the far edge", async ({
page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocument(githubActionsRunEmailHtml);

  for (const width of READER_WIDTHS) {
    const metrics = await measure(page, documentHtml, width);
    // `[mark][td width:100%][button]` is how email pushes two things apart.
    // A fix that neutralises the sender's widths collapses this to the left.
    expect(
      metrics.spacerGapPx,
      `spacer row lost its push at ${width}px`,
    ).toBeLessThanOrEqual(1);
  }
});

/**
 * Builds the frame the way the reader does once remote images are allowed:
 * every image bound to a blob the frame is permitted to load. The rasters are
 * drawn at the sizes the real assets have, because the bug is only visible
 * when the raster is larger than the size the sender asked for.
 */
function readerDocumentWithImages(
  emailHtml: string,
  raster: (sourceUrl: string) => readonly [number, number] = declaredGeometryDigestRaster,
): string {
  let allocated = 0;
  const sanitized = sanitizeMailHtmlWithRemoteImages(
    emailHtml,
    {
      maxCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
      maxNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
      maxAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
      maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
    },
    () => `remote-image-a${(allocated++).toString(16).padStart(32, "0")}`,
  );
  expect(sanitized.html).not.toBeNull();
  return createMailHtmlDocument({
    sanitizedHtml: sanitized.html ?? "",
    attachments: [],
    cidSources: new Map(),
    remoteSources: new Map(
      sanitized.remoteImages.map((image) => {
        const [width, height] = raster(image.sourceUrl);
        return [image.remoteImageId, `blob:raster-${width}-${height}-end`];
      }),
    ),
  });
}

type ImageMetrics = {
  readonly alt: string;
  readonly declaredWidth: number | null;
  readonly declaredHeight: number | null;
  /** The picture: the border box less the image's own padding and border. */
  readonly width: number;
  readonly height: number;
  /** The cell around it, so a fix cannot buy the picture with the gap. */
  readonly cellWidth: number | null;
  readonly cellGapAfter: number | null;
};

type ImageFrameMetrics = {
  readonly images: ImageMetrics[];
  /** How far the message pans sideways. A picture wider than its column is
   *  the one thing that widens a message that otherwise fits. */
  readonly pannablePx: number;
};

async function measureImages(
  page: import("playwright/test").Page,
  documentHtml: string,
  width: number,
): Promise<ImageFrameMetrics> {
  return page.evaluate(
    async ([html, frameWidth]) => {
      // Each placeholder names the raster it stands for, so the blob the frame
      // finally loads has the intrinsic size the real asset has.
      let source = html as string;
      for (const token of new Set(
        source.match(/blob:raster-\d+-\d+-end/g) ?? [],
      )) {
        const [, w, h] = /blob:raster-(\d+)-(\d+)-end/.exec(token)!;
        const canvas = document.createElement("canvas");
        canvas.width = Number(w);
        canvas.height = Number(h);
        canvas.getContext("2d")!.fillRect(0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((value) => resolve(value!), "image/png"),
        );
        source = source.split(token).join(URL.createObjectURL(blob));
      }

      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.style.cssText = `border:0;width:${frameWidth}px;height:3000px;display:block`;
      frame.srcdoc = source;
      await new Promise<void>((resolve) => {
        frame.addEventListener("load", () => resolve(), { once: true });
        document.body.append(frame);
      });
      const frameDocument = frame.contentDocument!;
      const images = [...frameDocument.querySelectorAll("img")];
      await Promise.all(
        images.map((image) =>
          image.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                image.addEventListener("load", () => resolve(), { once: true });
                image.addEventListener("error", () => resolve(), { once: true });
              }),
        ),
      );
      const declared = (image: HTMLImageElement, axis: "width" | "height") => {
        const attribute = image.getAttribute(axis);
        if (attribute !== null && /^\d+$/.test(attribute)) return Number(attribute);
        const inline = new RegExp(`(?:^|;)${axis}:([0-9.]+)px`).exec(
          image.getAttribute("style") ?? "",
        );
        return inline ? Number(inline[1]) : null;
      };
      // `getBoundingClientRect` is the border box. A sender that puts padding
      // or a border on the image itself declares the size of the picture, not
      // of the box around it, so the picture is what has to be measured.
      const round = (value: number) => Math.round(value * 10) / 10;
      const picture = (image: HTMLImageElement, axis: "width" | "height") => {
        const style = frame.contentWindow!.getComputedStyle(image);
        const [near, far] = axis === "width" ? ["Left", "Right"] : ["Top", "Bottom"];
        const strip =
          Number.parseFloat(style.getPropertyValue(`padding-${near.toLowerCase()}`)) +
          Number.parseFloat(style.getPropertyValue(`padding-${far.toLowerCase()}`)) +
          Number.parseFloat(style.getPropertyValue(`border-${near.toLowerCase()}-width`)) +
          Number.parseFloat(style.getPropertyValue(`border-${far.toLowerCase()}-width`));
        return round(image.getBoundingClientRect()[axis] - strip);
      };
      const root = frameDocument.getElementById("brain-mail-content")!;
      const pannablePx = root.scrollWidth - root.clientWidth;
      const metrics = images.map((image) => {
        const cell = image.closest("td");
        const next = cell?.nextElementSibling ?? null;
        return {
          alt: image.getAttribute("alt") ?? "",
          declaredWidth: declared(image, "width"),
          declaredHeight: declared(image, "height"),
          width: picture(image, "width"),
          height: picture(image, "height"),
          cellWidth: cell ? round(cell.getBoundingClientRect().width) : null,
          cellGapAfter: next
            ? round(
                next.getBoundingClientRect().left -
                  image.getBoundingClientRect().right,
              )
            : null,
        };
      });
      frame.remove();
      return { images: metrics, pannablePx };
    },
    [documentHtml, width] as const,
  );
}

test("@release a mail image draws at the size its sender declared", async ({
page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocumentWithImages(declaredGeometryDigestEmailHtml);

  for (const width of READER_WIDTHS) {
    const { images, pannablePx } = await measureImages(page, documentHtml, width);
    expect(images.length, `images at ${width}px`).toBe(19);
    expect(pannablePx, `message pans at ${width}px`).toBe(0);

    for (const image of images) {
      const where = `${image.alt || "(no alt)"} at ${width}px`;
      // A declared size is a size on both counts. Too large means the raster's
      // own pixels reached the screen — every raster here is 2x or more. Too
      // small means
      // some box between the picture and the column narrowed it, and none of
      // them is entitled to: the column is the only bound that is the reader's
      // to impose. Rounding on a ratio costs at most half a pixel.
      if (image.declaredWidth !== null) {
        expect(
          image.width,
          `${where}: drew ${image.width}px wide for a declared ${image.declaredWidth}px`,
        ).toBeCloseTo(image.declaredWidth, 0);
      }
      if (image.declaredHeight !== null) {
        expect(
          image.height,
          `${where}: drew ${image.height}px tall for a declared ${image.declaredHeight}px`,
        ).toBeCloseTo(image.declaredHeight, 0);
      }
      // Neither may it collapse: an icon with no declared width still has to
      // reach the width its own ratio gives it at the declared height.
      expect(image.width, `${where}: collapsed`).toBeGreaterThan(0);
      expect(image.height, `${where}: collapsed`).toBeGreaterThan(0);
    }

    // The three header icons declare a height and no width at all. Each one is
    // the height it asked for, and the width its 2x raster's ratio gives.
    for (const [alt, expectedWidth] of [
      ["Inbox icon", 31],
      ["Saved icon", 32],
      ["Alerts icon", 32],
    ] as const) {
      const icon = images.find((image) => image.alt === alt);
      expect(icon, `${alt} missing at ${width}px`).toBeDefined();
      expect(icon!.height, `${alt} height at ${width}px`).toBe(25);
      expect(icon!.width, `${alt} width at ${width}px`).toBe(expectedWidth);
    }
  }
});

test("@release a cell the sender declared narrower than its picture keeps both", async ({
page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocumentWithImages(declaredGeometryDigestEmailHtml);

  for (const width of READER_WIDTHS) {
    const { images, pannablePx } = await measureImages(page, documentHtml, width);
    // Both overflow their cells the way the sender meant; neither widens the
    // message.
    expect(pannablePx, `message pans at ${width}px`).toBe(0);

    // The listing card: a 48px logo inside `<td width="48"
    // style="width:48px;padding-right:8px">`. The picture is 48, and the cell
    // widens to carry it plus the padding the sender asked for. Reading the
    // declared cell width as a ceiling instead drew the logo at 40.
    const logo = images.find(
      (image) => image.declaredWidth === 48 && image.declaredHeight === 48,
    );
    expect(logo, `no 48px logo at ${width}px`).toBeDefined();
    expect(logo!.width, `logo width at ${width}px`).toBe(48);
    expect(logo!.cellWidth, `logo cell at ${width}px`).toBe(56);
    expect(logo!.cellGapAfter, `logo gap at ${width}px`).toBe(8);

    // The badge beside it: 16px of picture in an 8px cell. The sender means it
    // to overflow, every other client draws it, and this frame drew it at 4.
    const badge = images.find((image) => image.alt === "Quick reply");
    expect(badge, `no Quick reply badge at ${width}px`).toBeDefined();
    expect(badge!.width, `badge width at ${width}px`).toBe(16);
    expect(badge!.height, `badge height at ${width}px`).toBe(16);

    // The wordmark: 101px of picture inside the sender's own 84px anchor. Same
    // shape one level up, and it drew at 84.
    const wordmark = images.find((image) => image.declaredWidth === 101);
    expect(wordmark, `no wordmark at ${width}px`).toBeDefined();
    expect(wordmark!.width, `wordmark width at ${width}px`).toBe(101);
    expect(wordmark!.height, `wordmark height at ${width}px`).toBe(37);
  }
});

test("@release a picture in a padded cell fits the cell, and the message does not pan", async ({
  page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocumentWithImages(paddedHeroEmailHtml, () => [
    1200, 600,
  ]);

  for (const width of READER_WIDTHS) {
    const { images, pannablePx } = await measureImages(page, documentHtml, width);
    const hero = images.find((image) => image.alt === "Hero");
    expect(hero, `hero missing at ${width}px`).toBeDefined();

    // The cell is the picture's only box: the column less the frame's 16px
    // gutter, the table's 4px of default spacing and the cell's 32px of
    // padding. Bound by the column instead, the picture drew 16px wider than
    // its cell at every width and the message panned by the difference —
    // 36px at 390 and at 620.
    const cell = width - 16 - 4 - 32;
    expect(hero!.width, `hero width at ${width}px`).toBe(cell);
    expect(hero!.height, `hero height at ${width}px`).toBeCloseTo(cell / 2, 0);
    expect(pannablePx, `message pans at ${width}px`).toBe(0);
  }
});

test("@release the reader's column bounds a picture only where its box does not", async ({
  page,
}) => {
  await page.goto("/login");
  const documentHtml = readerDocumentWithImages(
    wideImageEmailHtml,
    (sourceUrl) => {
      const raster = WIDE_IMAGE_RASTERS.find(([name]) => sourceUrl.includes(name));
      expect(raster, `no raster size for ${sourceUrl}`).toBeDefined();
      return raster![1];
    },
  );

  for (const width of READER_WIDTHS) {
    const { images, pannablePx } = await measureImages(page, documentHtml, width);
    const hero = images.find((image) => image.alt === "Hero");
    const badge = images.find((image) => image.alt === "Badge");
    expect(hero, `hero missing at ${width}px`).toBeDefined();
    expect(badge, `badge missing at ${width}px`).toBeDefined();
    expect(pannablePx, `message pans at ${width}px`).toBe(0);

    // 1200px declared into a padded cell of a full-width table. The sender
    // does not get to widen the message: the cell wins and the ratio holds.
    const cell = width - 16 - 4 - 32;
    expect(hero!.width, `hero width at ${width}px`).toBe(cell);
    expect(hero!.height, `hero height at ${width}px`).toBeCloseTo(cell / 2, 0);

    // Sized by height alone, in a 20px cell. The picture is what the ratio
    // gives it at 24px tall, not what the cell would like it to be.
    expect(badge!.height, `badge height at ${width}px`).toBe(24);
    expect(badge!.width, `badge width at ${width}px`).toBe(96);
  }
});
