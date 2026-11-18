import { expect, it } from "vitest";
import { mailLinkDestination } from "./link-destination";

it("preserves a boarding pass query and its fragment", () => {
  const address = "https://airline.example/pass?id=ab%2Fcd&day=1#view";
  expect(mailLinkDestination(address)).toBe(address);
});

it("supports protocol-relative web links and mail handlers", () => {
  expect(mailLinkDestination("//airline.example/pass")).toBe("https://airline.example/pass");
  expect(mailLinkDestination("mailto:help@example.test?subject=My flight"))
    .toBe("mailto:help@example.test?subject=My%20flight");
});

it("rejects unsupported destinations in cached mail", () => {
  for (const address of ["/mail", "#message", "about:blank", "https://user@airline.example", ""]) {
    expect(mailLinkDestination(address)).toBeNull();
  }
});
