import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("generic upload route active MIME policy", () => {
  it.each(["image/x-svg+xml", "application/svg+xml"])(
    "rejects SVG alias %s before Store upload",
    async (mimeType) => {
      const form = new FormData();
      form.set(
        "file",
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
          "misleading.png",
          { type: mimeType },
        ),
      );
      const response = await POST(
        new NextRequest("https://brain.test/api/upload", {
          method: "POST",
          body: form,
        }),
      );

      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        error: "unsafe file type",
      });
    },
  );
});
