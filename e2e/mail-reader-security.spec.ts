import { expect, test } from "playwright/test";

test("sanitized mail iframe loads a parent blob without gaining script access", async ({
  page,
}) => {
  await page.goto("/login");
  const result = await page.evaluate(async () => {
    const parentUrlBefore = window.location.href;
    const bytes = Uint8Array.from(
      atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
      (character) => character.charCodeAt(0),
    );
    const source = URL.createObjectURL(new Blob([bytes], { type: "image/gif" }));
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.srcdoc = [
      "<!doctype html><html><head>",
      '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src blob:; script-src \'none\'; form-action \'none\'">',
      "</head><body>",
      `<img id="cid" src="${source}">`,
      '<a id="external" data-brain-href="https://attacker.test/path">Open</a>',
      "<script>parent.document.body.dataset.mailReaderPwned='yes'</script>",
      "</body></html>",
    ].join("");
    const loaded = await new Promise<boolean>((resolve) => {
      frame.addEventListener("load", () => {
        const image = frame.contentDocument?.getElementById("cid");
        if (image?.tagName !== "IMG") return resolve(false);
        const mailImage = image as HTMLImageElement;
        if (mailImage.complete) return resolve(mailImage.naturalWidth === 1);
        mailImage.addEventListener("load", () => resolve(mailImage.naturalWidth === 1), {
          once: true,
        });
        mailImage.addEventListener("error", () => resolve(false), { once: true });
      }, { once: true });
      window.setTimeout(() => resolve(false), 2_000);
      document.body.append(frame);
    });
    const scriptRan = document.body.dataset.mailReaderPwned === "yes";
    const frameUrlBefore = frame.contentWindow?.location.href;
    (frame.contentDocument?.getElementById("external") as HTMLAnchorElement).click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const frameUrlAfter = frame.contentWindow?.location.href;
    const parentUrlAfter = window.location.href;
    frame.remove();
    URL.revokeObjectURL(source);
    return {
      loaded,
      scriptRan,
      parentUrlBefore,
      parentUrlAfter,
      frameUrlBefore,
      frameUrlAfter,
    };
  });

  expect(result.loaded).toBe(true);
  expect(result.scriptRan).toBe(false);
  expect(result.parentUrlAfter).toBe(result.parentUrlBefore);
  expect(result.frameUrlAfter).toBe(result.frameUrlBefore);
});
