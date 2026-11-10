import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({verifySession: vi.fn(), readModules: vi.fn()}));
vi.mock("@/lib/auth", () => ({SESSION_COOKIE: "brain_session", verifySession: mocks.verifySession}));
vi.mock("@/lib/owner-settings", () => ({readModules: mocks.readModules}));
import { proxy } from "./proxy";
beforeEach(() => {vi.resetAllMocks(); mocks.verifySession.mockResolvedValue(true); mocks.readModules.mockResolvedValue({mail: true, tasks: false});});
describe("task category module wall", () => {
  it("refuses every catalog method before the handler when Tasks is off", async () => {
    for (const method of ["GET", "POST", "PATCH"]) {
      const response = await proxy(new NextRequest("https://brain.test/api/task-categories", {method}));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({error: "module_off", module: "tasks"});
    }
  });
  it("still requires authentication and passes an enabled catalog", async () => {
    mocks.verifySession.mockResolvedValue(false);
    expect((await proxy(new NextRequest("https://brain.test/api/task-categories"))).status).toBe(401);
    mocks.verifySession.mockResolvedValue(true);
    mocks.readModules.mockResolvedValue({mail: true, tasks: true});
    expect((await proxy(new NextRequest("https://brain.test/api/task-categories"))).status).toBe(200);
  });
});
