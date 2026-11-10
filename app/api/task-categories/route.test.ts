import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({listTaskCategories: vi.fn(), createTaskCategory: vi.fn(), updateTaskCategory: vi.fn()}));
vi.mock("@/lib/store", () => ({getStore: async () => mocks, isTaskValidation: (error: unknown) => error instanceof Error && error.name === "TaskValidationError"}));
import { GET, POST, PATCH } from "./route";
const request = (method: string, body?: unknown) => new NextRequest("https://brain.test/api/task-categories", {method, ...(body === undefined ? {} : {headers: {"content-type": "application/json"}, body: JSON.stringify(body)})});
beforeEach(() => {vi.resetAllMocks(); mocks.listTaskCategories.mockResolvedValue([{name: "Empty", icon: "✨"}]); mocks.createTaskCategory.mockResolvedValue({name: "Empty"}); mocks.updateTaskCategory.mockResolvedValue({name: "Empty"});});
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
});
