import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({getStore:vi.fn(),moveTask:vi.fn()}));
vi.mock("@/lib/store",()=>({getStore:mocks.getStore,isNotFound:(error:Error)=>error.name==="NotFoundError",isTaskValidation:(error:Error)=>error.name==="TaskValidationError"}));
import { POST } from "./route";
const valid={category:"Work",beforeId:null,today:"2026-11-11"};
const call=(body:unknown,id="task",query="")=>POST(new NextRequest(`https://brain.test/api/tasks/${id}/move${query}`,{method:"POST",headers:{"content-type":"application/json","x-brain-client":"tab"},body:JSON.stringify(body)}),{params:Promise.resolve({id})});
beforeEach(()=>{mocks.getStore.mockReset().mockResolvedValue({moveTask:mocks.moveTask});mocks.moveTask.mockReset().mockResolvedValue({id:"task",category:"Work",order:"a0"});});
describe("task move route",()=>{
  it("passes one validated placement to the Store with caller identity",async()=>{
    const response=await call({...valid,category:"  Work  "});expect(response.status).toBe(200);
    expect(mocks.moveTask).toHaveBeenCalledWith("task",valid,"tab");
    expect(await response.json()).toEqual({task:{id:"task",category:"Work",order:"a0"}});
  });
  it.each([null,[],{}, {...valid,today:"2026-02-30"},{...valid,category:" "},{...valid,beforeId:"../bad"},{...valid,done:true},{...valid,order:"a0"}])("rejects malformed body %j before opening Store",async body=>{
    expect((await call(body)).status).toBe(400);expect(mocks.getStore).not.toHaveBeenCalled();
  });
  it("rejects invalid ids and extra query parameters",async()=>{
    expect((await call(valid,"bad.id")).status).toBe(400);
    expect((await call(valid,"task","?today=2026-11-11")).status).toBe(400);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });
  it("reports missing tasks, invalid destinations, and unexpected write failures honestly",async()=>{
    mocks.moveTask.mockRejectedValueOnce(Object.assign(new Error("missing"),{name:"NotFoundError"}));expect((await call(valid)).status).toBe(404);
    mocks.moveTask.mockRejectedValueOnce(Object.assign(new Error("moved"),{name:"TaskValidationError",reason:"destination changed"}));
    const bad=await call(valid);expect(bad.status).toBe(400);expect(await bad.json()).toMatchObject({error:"destination changed"});
    mocks.moveTask.mockRejectedValueOnce(new Error("disk failed"));await expect(call(valid)).rejects.toThrow("disk failed");
  });
});
