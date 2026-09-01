import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getStore: vi.fn() }));

vi.mock("./store", () => ({ getStore: mocks.getStore }));

import { smartSort } from "./smart-sort";

const children = Array.from({ length: 4 }, (_, index) => ({
  id: `page-${index + 1}`,
  title: `Page ${index + 1}`,
  children: [],
}));

describe("Smart sort small sets", () => {
  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    mocks.getStore.mockResolvedValue({
      getTree: () => [{ id: "parent", title: "Parent", children }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("asks for two balanced sections when a page has four children", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  sections: ["One", "Two"],
                  assignments: {
                    "page-1": "One",
                    "page-2": "One",
                    "page-3": "Two",
                    "page-4": "Two",
                  },
                }),
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await smartSort("parent");

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toContain(
      "into 2 BALANCED thematic sections",
    );
    expect(result).toMatchObject({ count: 4, sections: ["One", "Two"] });
    expect(Object.keys(result.assignments)).toHaveLength(4);
  });

  it("fails honestly when the AI is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 503 })));
    await expect(smartSort("parent")).rejects.toThrow("smart sort unavailable");
  });

  it("rejects a 200 response that contains no usable thematic assignments", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    sections: ["One", "Two"],
                    assignments: {},
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );

    await expect(smartSort("parent")).rejects.toThrow("smart sort unavailable");
  });
});

describe("Smart sort ordering inside a section", () => {
  const imported = "2026-07-08T00:00:00.000Z";
  const garden = [
    { id: "mulch", title: "Мульча", created: imported, children: [] },
    { id: "mar-9", title: "Запись 9 марта", created: imported, children: [] },
    { id: "tools", title: "Инструменты", created: imported, children: [] },
    { id: "jun-23", title: "Запись 23 июня", created: imported, children: [] },
    { id: "may-12", title: "Запись 12 мая", created: imported, children: [] },
  ];

  beforeEach(() => {
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    mocks.getStore.mockResolvedValue({
      getTree: () => [{ id: "garden", title: "Огород", children: garden }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    sections: ["Посадки", "Записи"],
                    assignments: {
                      mulch: "Посадки",
                      tools: "Посадки",
                      "mar-9": "Записи",
                      "jun-23": "Записи",
                      "may-12": "Записи",
                    },
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reads a dated section newest first and leaves an undated one alone", async () => {
    const result = await smartSort("garden");

    expect(result.order).toEqual([
      "mulch",
      "tools",
      "jun-23",
      "may-12",
      "mar-9",
    ]);
    expect(result.order).toHaveLength(result.count);
  });
});
