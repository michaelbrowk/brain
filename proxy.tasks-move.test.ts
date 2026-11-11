import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({verifySession:vi.fn(),readModules:vi.fn()}));
vi.mock("@/lib/auth",()=>({SESSION_COOKIE:"brain_session",verifySession:mocks.verifySession}));
vi.mock("@/lib/owner-settings",()=>({readModules:mocks.readModules}));
import { proxy } from "./proxy";
const request=()=>new NextRequest("https://brain.test/api/tasks/task-1/move",{method:"POST"});
beforeEach(()=>{vi.resetAllMocks();mocks.verifySession.mockResolvedValue(true);mocks.readModules.mockResolvedValue({mail:true,tasks:true});});
describe("task move authorization",()=>{
  it("requires owner authentication before reaching the handler",async()=>{
    mocks.verifySession.mockResolvedValue(false);
    expect((await proxy(request())).status).toBe(401);
    expect(mocks.readModules).not.toHaveBeenCalled();
  });
  it("refuses a disabled Tasks module and passes an enabled owner",async()=>{
    mocks.readModules.mockResolvedValueOnce({mail:true,tasks:false});
    const response=await proxy(request());
    expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"module_off",module:"tasks"});
    expect((await proxy(request())).status).toBe(200);
  });
});
