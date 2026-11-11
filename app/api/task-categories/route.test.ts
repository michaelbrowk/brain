import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({listTaskCategories: vi.fn(), createTaskCategory: vi.fn(), updateTaskCategory: vi.fn(), deleteTaskCategory: vi.fn()}));
vi.mock("@/lib/store", () => ({getStore: async () => mocks, isTaskValidation: (error: unknown) => error instanceof Error && error.name === "TaskValidationError"}));
import { GET, POST, PATCH, DELETE } from "./route";
const request = (method: string, body?: unknown) => new NextRequest("https://brain.test/api/task-categories", {method, ...(body === undefined ? {} : {headers: {"content-type": "application/json"}, body: JSON.stringify(body)})});
beforeEach(() => {vi.resetAllMocks(); mocks.listTaskCategories.mockResolvedValue([{name: "Empty", icon: "✨"}]); mocks.createTaskCategory.mockResolvedValue({name: "Empty"}); mocks.updateTaskCategory.mockResolvedValue({name: "Empty"}); mocks.deleteTaskCategory.mockResolvedValue({cleared: 3});});
describe("task category routes", () => {
  it("lists persisted empty categories and creates through the Store", async () => {
    expect(await (await GET(request("GET"))).json()).toEqual({categories: [{name: "Empty", icon: "✨"}]});
    expect((await POST(request("POST", {name: "Empty", icon: "✨"}))).status).toBe(201);
    expect(mocks.createTaskCategory).toHaveBeenCalledWith("Empty", "✨", undefined);
  });
  it("clears an icon explicitly and refuses undeclared fields", async () => {
    expect((await PATCH(request("PATCH", {name: "Empty", icon: null}))).status).toBe(200);
    expect(mocks.updateTaskCategory).toHaveBeenCalledWith("Empty", null, undefined);
    expect((await PATCH(request("PATCH", {name: "Empty"}))).status).toBe(400);
    expect((await POST(request("POST", {name: "Empty", path: "../private"}))).status).toBe(400);
    expect(mocks.createTaskCategory).not.toHaveBeenCalled();
  });
  it("deletes through the Store and forwards the originating client", async () => {
    const req = request("DELETE", {name: "Work"});
    req.headers.set("x-brain-client", "writer-tab");
    const response = await DELETE(req);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({cleared: 3});
    expect(mocks.deleteTaskCategory).toHaveBeenCalledWith("Work", "writer-tab");
  });
  it("allows an unknown category to be an idempotent deletion", async () => {
    mocks.deleteTaskCategory.mockResolvedValue({cleared: 0});
    expect(await (await DELETE(request("DELETE", {name: "Missing"}))).json()).toEqual({cleared: 0});
    expect(mocks.deleteTaskCategory).toHaveBeenCalledWith("Missing", undefined);
  });
  it.each([null, [], {}, {name: 1}, {name: ""}, {name: "  "}, {name: "Work\nPrivate"}, {name: "x".repeat(201)}, {name: "Work", icon: "✨"}, {name: "Work", src: "spoof"}, {name: "Work", path: "../private"}])("refuses malformed delete input %j without touching the Store", async body => {
    expect((await DELETE(request("DELETE", body))).status).toBe(400);
    expect(mocks.deleteTaskCategory).not.toHaveBeenCalled();
  });
  it("refuses invalid JSON and query parameters without touching the Store", async () => {
    expect((await DELETE(new NextRequest("https://brain.test/api/task-categories", {method: "DELETE", body: "{"}))).status).toBe(400);
    for (const query of ["today=2026-11-11", "offset=240", "name=Work", "unknown=true"]) {
      const req = new NextRequest(`https://brain.test/api/task-categories?${query}`, {method: "DELETE", body: JSON.stringify({name: "Work"})});
      expect((await DELETE(req)).status).toBe(400);
    }
    expect(mocks.deleteTaskCategory).not.toHaveBeenCalled();
  });
  it("returns validation failures as 400 and never reports an I/O failure as success", async () => {
    mocks.deleteTaskCategory.mockRejectedValue(Object.assign(new Error("invalid category name"), {name: "TaskValidationError", reason: "invalid category name"}));
    expect((await DELETE(request("DELETE", {name: "Work"}))).status).toBe(400);
    mocks.deleteTaskCategory.mockRejectedValue(new Error("disk failed"));
    await expect(DELETE(request("DELETE", {name: "Work"}))).rejects.toThrow("disk failed");
  });
});
