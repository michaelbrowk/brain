// Owner-gate artifact capture for the page cover — run on demand:
//
//   COVER_SHOTS=1 pnpm exec playwright test e2e/cover-shots.spec.ts
//
// Screenshots land in docs/design/cover/. Skipped everywhere else so the full
// e2e suite never rewrites the committed artifacts.
//
// Two fixtures, because the dissolve has two ways to fail and neither fixture
// shows both. A high-frequency ray image is the worst case for a ramp over a
// saturated photo: thin high-contrast edges meeting the canvas, and the
// strongest colour that can reach the sidebar's glass. A near-paper gradient
// is the worst case for mud — a pale image has almost no contrast against the
// canvas, so a fade that dips or bands anywhere reads as a smear.
import { expect, test, type Page } from "playwright/test";
import path from "node:path";
import sharp from "sharp";

const OUT = path.join(process.cwd(), "docs", "design", "cover");

test.skip(process.env.COVER_SHOTS !== "1", "artifact capture — run with COVER_SHOTS=1");

/** Sunburst rays in warm orange — a pattern real covers carry, and the worst
 *  case for any edge treatment: thin high-contrast edges meeting the canvas,
 *  and a saturated colour arriving at the sidebar. */
async function rayCover(width: number, height: number) {
  const data = Buffer.alloc(width * height * 3);
  const cx = width / 2;
  const cy = height * 1.6;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const angle = Math.atan2(y - cy, x - cx);
      const ray = 0.5 + 0.5 * Math.sin(angle * 90);
      const radial = Math.min(1, Math.hypot(x - cx, y - cy) / (width * 0.75));
      const t = Math.min(1, ray * 0.55 + (1 - radial) * 0.75);
      const index = (width * y + x) * 3;
      data[index] = Math.round(196 + 59 * t);
      data[index + 1] = Math.round(38 + 140 * t);
      data[index + 2] = Math.round(12 + 30 * t);
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") && candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(scheme === "dark");
}

/** A page with enough body to scroll: the travelling frames have to prove the
 *  cover goes under the pills rather than being cropped by them. */
async function makePage(page: Page, title: string) {
  const created = await page.evaluate(async (pageTitle) => {
    const body = Array.from(
      { length: 40 },
      (_, i) => `Paragraph ${i}: the paper is the window, the chrome floats over it.`,
    ).join("\n\n");
    const response = await fetch("/api/page", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: pageTitle,
        icon: "🌻",
        markdown: `## What the edge decides\n\n${body}`,
      }),
    });
    return (await response.json()) as { id: string };
  }, title);
  await page.goto(`/p/${created.id}`);
  return created.id;
}

async function uploadRayCover(page: Page) {
  await page.getByRole("button", { name: "Add cover" }).click();
  // The editor has its own attachment input, so address the picker's through
  // the file chooser its button opens rather than by selector.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("button", { name: "Upload image" }).click(),
  ]);
  await chooser.setFiles({
    name: "cover.png",
    mimeType: "image/png",
    buffer: await rayCover(1440, 260),
  });
  await expect(page.locator(".brain-cover img")).toBeVisible();
  await page.waitForTimeout(600);
}

async function rest(page: Page) {
  // nudge the scroller and come back: a backdrop-filter layer keeps a stale
  // snapshot of its backdrop when the content behind it appears while the
  // colour scheme is being emulated, and every frame here is judged on what
  // the glass is refracting. One real scroll forces the re-sample.
  await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 240 }));
  await page.waitForTimeout(250);
  await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 0 }));
  await page.mouse.move(4, 700);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.waitForTimeout(400);
}

/** The whole window, sidebar included. A cover that runs under the sidebar is
 *  judged on what the sidebar does with it; clipping to the canvas would hide
 *  the only thing that matters. */
async function frame(page: Page, name: string, scrollTop = 0) {
  await page.locator(".brain-page-scroll").evaluate((el, top) => el.scrollTo({ top }), scrollTop);
  await page.waitForTimeout(400);
  const view = page.viewportSize()!;
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    clip: { x: 0, y: 0, width: view.width, height: Math.min(view.height, 470) },
  });
}

/** Read the bands off the layout rather than off the custom properties: an
 *  unregistered property hands back its calc() unevaluated. .brain-cover-left
 *  IS the ramp — it starts at the sidebar's right edge and ends where the
 *  cover reaches full density. */
const geometry = (page: Page) =>
  page.evaluate(() => {
    const band = document.querySelector(".brain-cover-left")!.getBoundingClientRect();
    return { glass: band.left, ramp: band.width };
  });

/** The close-up this change exists for. Left to right: the sidebar's interior
 *  over the residue, the sidebar's own right edge, the 12px gutter, the ramp,
 *  and open cover. 2× nearest-neighbour — a dissolve is judged on whether it
 *  bands, and a resampling kernel would smooth away the evidence. */
async function leftEdge(page: Page, name: string) {
  const box = (await page.locator(".brain-cover").boundingBox())!;
  const { glass, ramp } = await geometry(page);
  const width = Math.round(glass + ramp + 70);
  const shot = await page.screenshot({
    clip: { x: 0, y: Math.round(box.y + 56), width, height: 150 },
  });
  await sharp(shot)
    .resize({ width: width * 2, kernel: "nearest" })
    .png()
    .toFile(path.join(OUT, `${name}.png`));
}

/** The numbers behind the close-up: a 1px row from the window's left edge
 *  through the residue, the gutter and the ramp into open cover. A cut is a
 *  single large step between neighbours; a dissolve is a run of small ones. */
async function measureLeft(page: Page, label: string) {
  const box = (await page.locator(".brain-cover").boundingBox())!;
  const { glass, ramp } = await geometry(page);
  const width = Math.round(glass + ramp + 48);
  const strip = await page.screenshot({
    clip: { x: 0, y: Math.round(box.y + box.height / 2), width, height: 1 },
  });
  const { data } = await sharp(strip).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number) => `${data[x * 3]},${data[x * 3 + 1]},${data[x * 3 + 2]}`;
  // the ramp only — the sidebar's own right edge is a real edge and is not
  // what this measures
  let worst = 0;
  let worstAt = 0;
  for (let x = Math.round(glass) + 14; x < width; x += 1) {
    const step =
      Math.abs(data[x * 3] - data[(x - 1) * 3]) +
      Math.abs(data[x * 3 + 1] - data[(x - 1) * 3 + 1]) +
      Math.abs(data[x * 3 + 2] - data[(x - 1) * 3 + 2]);
    if (step > worst) {
      worst = step;
      worstAt = x;
    }
  }
  console.log(
    `LEFT ${label}  sidebar-mid ${at(150)}  sidebar-edge ${at(Math.round(glass) - 2)}  gutter ${at(Math.round(glass) + 6)}  ramp+40 ${at(Math.round(glass) + 40)}  ramp+120 ${at(Math.round(glass) + 120)}  open ${at(width - 4)}  worst 1px step in the ramp ${worst} at x=${worstAt}`,
  );
}

/** Columns of open cover that nothing else paints in. The foot band is not
 *  empty: the floating pills travel through it on scroll, the page icon
 *  overlaps its last 36px (the article carries -mt-9), and Change / Remove sit
 *  12 in from the bottom-right corner. Everything else over the band is a
 *  transparent box, so the blockers are exactly the things that carry ink. */
const openColumns = (page: Page) =>
  page.evaluate(() => {
    const cover = document.querySelector(".brain-cover")!.getBoundingClientRect();
    const ramp = document.querySelector(".brain-cover-left")!.getBoundingClientRect();
    const blocked = [
      ...document.querySelectorAll(
        ".brain-topbar .toolbar-pill, .brain-topbar .crumb, .brain-topbar button, .brain-cover-controls, .brain-page-article button, .brain-page-article textarea",
      ),
    ]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.bottom > cover.top && r.top < cover.bottom)
      .map((r) => [r.left - 8, r.right + 8] as const);
    const out: number[] = [];
    // every 16th column of open cover, not three chosen ones — the complaint
    // was a line across the whole canvas, so the whole canvas is walked
    for (let x = Math.round(ramp.right + 40); x < window.innerWidth - 24; x += 16) {
      if (blocked.every(([a, b]) => x < a || x > b)) out.push(x);
    }
    return out;
  });

/** The numbers behind the dissolve, read the other way round. `measureLeft`
 *  walks ACROSS the ramp; this walks DOWN the band, which is where the foot
 *  has failed twice, in two different ways.
 *
 *  The first was a cliff — a backdrop layer masked to full opacity at the
 *  bottom of its own box drags the cover's colour ~20px past the point the
 *  alpha has let go, then stops with the box. A worst-1px-step bar catches
 *  that, and it is asserted below.
 *
 *  The second was not a cliff and the step bar could not see it: adjacent rows
 *  differed by ~2/255 the whole way down and the gate passed, while the fade
 *  still read as sharp. That failure is about RATE, not about steps. The whole
 *  density loss sat in the last 80px of a 220px cover at a near-constant 2.3
 *  levels per pixel, so the band had a beginning: above it the picture was
 *  vivid, below it visibly draining, and the eye finds that line the same way
 *  it finds an edge. So the walk also records where the fade starts, where it
 *  ends, and how fast it runs in between — and asserts the two properties that
 *  make a beginning impossible to locate: the peak rate is bounded, and the
 *  loss is spread over a run at least half the banner tall.
 *
 *  Both are asserted only where there is a picture to measure. A pale cover
 *  swings ~30 levels from top to canvas, so its rate numbers are quantisation,
 *  not shape; those frames print and are read by eye. */
// Both bars sit between what the shipped fade measured and what the eased one
// does, with room for a renderer's rounding. The near-linear stop list this
// replaced read 2.75 levels per pixel over a 98px run on the ray fixture; the
// smoothstep reads 1.89–1.95 over 133–139, and the spread across themes and
// both viewport widths is 2%.
const RATE_CEILING = 2.3;
const RUN_FLOOR = 0.5;

async function measureFoot(page: Page, label: string) {
  const box = (await page.locator(".brain-cover").boundingBox())!;
  const cols = await openColumns(page);
  const view = page.viewportSize()!;
  const bottom = Math.round(box.y + box.height);
  const top = Math.max(0, Math.round(box.y));
  const clipped = box.y < -1;
  const strip = await page.screenshot({
    clip: { x: 0, y: top, width: view.width, height: Math.min(bottom + 4, view.height) - top },
  });
  const { data, info } = await sharp(strip).raw().toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * info.channels;
    return [data[i], data[i + 1], data[i + 2]];
  };

  // The cliff is local — a layer stopping at its own box edge shows on the row
  // it stops on — so the step bar is read per column and takes the worst.
  let worst = 0;
  let worstAt = [0, 0];
  for (const x of cols) {
    for (let y = 1; y < info.height; y += 1) {
      const step = Math.max(...[0, 1, 2].map((c) => Math.abs(at(x, y - 1)[c] - at(x, y)[c])));
      if (step > worst) {
        worst = step;
        worstAt = [x, top + y];
      }
    }
  }

  // The rate is not local: the mask is the same gradient at every x, so what
  // varies between columns is the picture, not the dissolve. Reading a single
  // column measures the ray fixture's own vertical contrast as much as the
  // fade — on this cover the worst column returns 2.7/px where the mean row
  // returns 2.0. So average the open columns into one profile first, and read
  // the shape off that.
  const rows: number[][] = [];
  for (let y = 0; y < info.height; y += 1) {
    rows.push(
      [0, 1, 2].map(
        (c) => cols.reduce((sum, x) => sum + at(x, y)[c], 0) / cols.length,
      ),
    );
  }
  // the channel that carries the dissolve — blue over a warm cover in light,
  // red in dark, and never the one the canvas shares with it
  const head = rows[0];
  const tail = rows[rows.length - 1];
  const chan = [0, 1, 2].reduce((best, c) =>
    Math.abs(tail[c] - head[c]) > Math.abs(tail[best] - head[best]) ? c : best,
  );
  const prof = rows.map((row) => row[chan]);
  const swing = Math.abs(prof[prof.length - 1] - prof[0]);
  const sign = Math.sign(prof[prof.length - 1] - prof[0]) || 1;
  // a 7px window: narrow enough to see a stop-to-stop corner in the gradient,
  // wide enough that 8-bit quantisation is not the thing being measured
  const rate = prof.map((_, y) => {
    const a = Math.max(0, y - 3);
    const b = Math.min(prof.length - 1, y + 3);
    return (sign * (prof[b] - prof[a])) / (b - a);
  });
  const peak = Math.max(...rate);
  const cross = (f: number) =>
    prof.findIndex((v) => (v - prof[0]) * sign >= f * swing);
  const run = cross(0.95) - cross(0.05);
  const onsetIndex = rate.findIndex((r) => r > 0.5);
  const profile: string[] = [];
  for (let y = 0; y < prof.length; y += Math.max(1, Math.round(prof.length / 11))) {
    profile.push(`${top + y}:${prof[y].toFixed(0)}/${rate[y].toFixed(1)}`);
  }
  profile.push(`${top + prof.length - 1}:${prof[prof.length - 1].toFixed(0)}`);

  const bar = Math.round(RUN_FLOOR * box.height);
  console.log(
    `FOOT ${label}  ${cols.length} columns ${cols[0]}–${cols[cols.length - 1]}  cover ${box.y.toFixed(0)}..${bottom}${clipped ? " (top clipped by the scroll — rate not judged)" : ""}  swing ${swing.toFixed(0)}  worst 1px step ${worst} at x=${worstAt[0]} y=${worstAt[1]}  peak rate ${peak.toFixed(2)}/px at y=${top + rate.indexOf(peak)}  onset ${onsetIndex < 0 ? "none" : `y=${top + onsetIndex}`}  5%\u219295% run ${run}px (floor ${bar})`,
  );
  console.log(`  mean row  y:level/rate  ${profile.join(" ")}`);

  // a dissolve is a run of small steps — the cliff bar the left ramp holds
  expect(worst, `the foot cuts instead of dissolving (${label})`).toBeLessThanOrEqual(11);
  // and it has no beginning to find: bounded rate, spread over a long run.
  // Both need a picture with density to lose; a pale cover has none.
  if (!clipped && swing >= 60) {
    expect(peak, `the foot dissolves too fast to have no onset (${label})`).toBeLessThanOrEqual(
      RATE_CEILING,
    );
    expect(
      run,
      `the foot's loss is compressed into too short a run (${label})`,
    ).toBeGreaterThanOrEqual(bar);
  }
}

/** Measured contrast of the sidebar's own content over whatever the glass is
 *  refracting. The ink is the element's computed colour; the ground is the
 *  median luminance of its box, which is background — glyph coverage in a
 *  label is well under half. Percentiles would read the antialiasing fringe;
 *  the extremes would read the icon. */
async function sidebarContrast(page: Page, label: string) {
  const targets: [string, ReturnType<Page["locator"]>][] = [
    ["Search", page.locator(".brain-sidebar").getByText("Search").first()],
    ["Today thoughts", page.locator(".brain-sidebar").getByText("Today thoughts").first()],
    ["Mail", page.locator(".brain-sidebar").getByText("Mail").first()],
    ["Pinned chip", page.locator(".brain-sidebar-pinned").getByText(/Cover/).first()],
    ["tree row", page.locator(".brain-sidebar").getByText("Cover and canvas").last()],
  ];
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (r: number, g: number, b: number) =>
    0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  const out: string[] = [];
  for (const [name, locator] of targets) {
    const box = await locator.boundingBox().catch(() => null);
    if (!box) {
      out.push(`${name} —`);
      continue;
    }
    // the ink tokens are authored in oklch, and getComputedStyle hands the
    // colour back in that space. Rasterise one pixel of it and read the pixel:
    // the browser's own conversion, with no colour maths here.
    const ink = await locator.evaluate((el) => {
      const canvas = document.createElement("canvas");
      canvas.width = 1;
      canvas.height = 1;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = getComputedStyle(el).color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    });
    const shot = await page.screenshot({
      clip: {
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.max(8, Math.round(box.width)),
        height: Math.max(8, Math.round(box.height)),
      },
    });
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
    const pixels: [number, number, number][] = [];
    for (let i = 0; i < info.width * info.height; i += 1) {
      pixels.push([data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]);
    }
    pixels.sort((a, b) => luminance(...a) - luminance(...b));
    const groundRgb = pixels[Math.floor(pixels.length / 2)];
    // an ink token may carry alpha; what the reader sees is it over the ground
    const text = luminance(
      ...(groundRgb.map((c, i) => ink[3] * ink[i] + (1 - ink[3]) * c) as [
        number,
        number,
        number,
      ]),
    );
    const ground = luminance(...groundRgb);
    const [hi, lo] = ground > text ? [ground, text] : [text, ground];
    out.push(`${name} ${((hi + 0.05) / (lo + 0.05)).toFixed(2)}:1`);
  }
  console.log(`SIDEBAR ${label}  ${out.join("  ")}`);
}

test("capture the cover dissolving under the sidebar", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await makePage(page, "Cover and canvas");
  await page.getByRole("button", { name: /^Pin/ }).first().click();
  await page.waitForTimeout(400);

  // the sidebar before anything runs under it, so the numbers after have
  // something to be a delta from
  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await rest(page);
    await sidebarContrast(page, `no cover ${scheme}`);
  }
  await uploadRayCover(page);

  const cover = page.locator(".brain-cover");
  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await page.setViewportSize({ width: 1440, height: 900 });

    // At rest: the cover fills the canvas, runs up under the pills to the
    // window's top edge, and left under the sidebar. Hovered, so the frame
    // carries the controls too.
    await cover.hover();
    await frame(page, `cover-rest-${scheme}`);

    // The left edge, magnified from the window's own edge, plus the numbers
    // under it. This is the frame the change is judged on.
    await rest(page);
    await leftEdge(page, `cover-left-edge-${scheme}`);
    await measureLeft(page, `rays ${scheme}`);
    await measureFoot(page, `rays ${scheme} at rest`);
    await sidebarContrast(page, `rays ${scheme}`);

    // The sidebar over the residue, at 1:1, so its content is read rather
    // than measured.
    await page.screenshot({
      path: path.join(OUT, `cover-sidebar-${scheme}.png`),
      clip: { x: 0, y: 0, width: 340, height: 470 },
    });

    // Travelling under the chrome.
    await frame(page, `cover-scrolled-${scheme}`, 120);

    // A narrow window. With a bleed the pills always overlap the cover, so
    // this is the crowded case rather than the only overlapping one: less
    // canvas for the ramp, and the actions pill sitting on the photo.
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.waitForTimeout(200);
    // the rate numbers need the whole banner in the viewport, so read the
    // narrow window at rest as well: scrolled, the cover's top is off-screen
    // and only the cliff bar can be judged
    await rest(page);
    await measureFoot(page, `rays ${scheme} at 1180 at rest`);
    await frame(page, `cover-under-pill-${scheme}`, 120);
    await measureFoot(page, `rays ${scheme} under the pill`);
  }
});

test("capture the dissolve on a pale cover", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await makePage(page, "Cover edge");

  // grad:4 opens on bare var(--paper) — near enough to the canvas that a fade
  // with any dip or band in it reads as a smear instead of a dissolve, and
  // the case where a residue under the glass could go grey.
  await page.getByRole("button", { name: "Add cover" }).click();
  await page.getByRole("button", { name: "Use gradient cover 4" }).click();
  await expect(page.locator(".brain-cover")).toBeVisible();
  await page.waitForTimeout(500);

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);
    await rest(page);
    await frame(page, `cover-pale-${scheme}`);
    await leftEdge(page, `cover-pale-left-edge-${scheme}`);
    await measureLeft(page, `pale ${scheme}`);
    await measureFoot(page, `pale ${scheme}`);
  }
});

test("count the backdrop layers a covered page carries", async ({ page }) => {
  test.setTimeout(240_000);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await makePage(page, "Cover budget");
  await uploadRayCover(page);
  // scrolled far enough that the pills are live and the cover is still in the
  // viewport — the @release budget test runs on a coverless page, so the two
  // always-on bands never reach it. Count them here, where they exist.
  await page.locator(".brain-page-scroll").evaluate((el) => el.scrollTo({ top: 80 }));
  await page.waitForTimeout(300);
  const count = () =>
    page.evaluate(() => {
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const layers: string[] = [];
      const nested: string[] = [];
      const tag = (el: Element) =>
        `${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0] || `i of ${el.parentElement?.className}`}`;
      for (const el of document.querySelectorAll("*")) {
        if (getComputedStyle(el).backdropFilter === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) {
          layers.push(tag(el));
        }
        let parent = el.parentElement;
        while (parent) {
          if (getComputedStyle(parent).backdropFilter !== "none") {
            nested.push(`${tag(el)} inside ${tag(parent)}`);
            break;
          }
          parent = parent.parentElement;
        }
      }
      return { layers, nested };
    });

  const at_rest = await count();
  console.log(`BUDGET covered /p scrolled: ${at_rest.layers.length} — ${at_rest.layers.join(", ")}`);
  console.log(`BUDGET nested: ${at_rest.nested.length ? at_rest.nested.join(", ") : "none"}`);

  // and the worst case the budget reserves a slot for: a popover open over a
  // covered page. This is the number that decided the left band is one layer.
  await page.getByRole("button", { name: "Page actions" }).last().click();
  await page.waitForTimeout(400);
  const withPopover = await count();
  console.log(
    `BUDGET covered /p + popover: ${withPopover.layers.length} — ${withPopover.layers.join(", ")}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // the case the popover does not cover: the palette is a thick panel of its
  // own AND it carries a scroller, so it is the deepest stack the app can put
  // over a covered page.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".brain-palette")).toBeVisible();
  await page.waitForTimeout(400);
  const withPalette = await count();
  console.log(
    `BUDGET covered /p + palette: ${withPalette.layers.length} — ${withPalette.layers.join(", ")}`,
  );
  await page.keyboard.press("Escape");

  expect(at_rest.nested).toEqual([]);
  expect(withPopover.nested).toEqual([]);
  expect(withPalette.nested).toEqual([]);
  expect(withPopover.layers.length).toBeLessThanOrEqual(8);
  expect(withPalette.layers.length).toBeLessThanOrEqual(8);
});
