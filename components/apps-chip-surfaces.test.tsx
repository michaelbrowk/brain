// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { TreeRow } from "./ui/tree-row";

let host: HTMLDivElement | null = null;

afterEach(() => {
  host?.remove();
  host = null;
});

function mount(node: React.ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  act(() => {
    createRoot(host as HTMLDivElement).render(node);
  });
  return host;
}

describe("the chip on a tree row", () => {
  it("draws after the title when the page is an app", () => {
    const row = mount(<TreeRow title="Trainer" ai />);
    const chip = row.querySelector(".ai-chip");
    expect(chip?.textContent).toBe("AI");
    const title = row.querySelector(".tree-row-title") as HTMLElement;
    expect(
      title.compareDocumentPosition(chip as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("draws nothing on an ordinary page", () => {
    const row = mount(<TreeRow title="Spanish" />);
    expect(row.querySelector(".ai-chip")).toBeNull();
  });

  it("is not read off the title", () => {
    const row = mount(<TreeRow title="AI notes" />);
    expect(row.querySelector(".ai-chip")).toBeNull();
  });
});
