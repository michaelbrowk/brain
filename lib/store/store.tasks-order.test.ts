import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as taskFiles from "../tasks/index-store";
import * as orderFiles from "./task-order";
import { compareTaskOrder } from "../tasks/order";
import { hashTaskText, normalizeTaskText } from "../tasks/task-lines";
import { Store } from "./store";
const roots: string[]=[];
const today="2026-11-11";
async function notebook() {const root=await fs.mkdtemp(path.join(os.tmpdir(),"brain-task-order-"));roots.push(root);const store=new Store(root);await store.init();return{root,store};}
const ids=(store:Store, category:string)=>store.allTaskViews().filter(t=>!t.done&&(t.category??"").toLowerCase()===category.toLowerCase()).sort((a,b)=>compareTaskOrder(a,b,today)).map(t=>t.id);
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});

describe("persistent task placement",()=>{
  it("reorders among all category tasks and survives restart and old index reads",async()=>{
    const{root,store}=await notebook();
    const a=await store.createTask({title:"a",category:"Work",when:today});
    const b=await store.createTask({title:"b",category:"Work",when:"2026-12-01"});
    const c=await store.createTask({title:"c",category:"Work",when:today});
    await store.moveTask(c.id,{category:"Work",beforeId:a.id,today});
    expect(ids(store,"Work")).toEqual([c.id,a.id,b.id]);
    const reloaded=new Store(root);await reloaded.init();
    expect(ids(reloaded,"Work")).toEqual([c.id,a.id,b.id]);
    expect(reloaded.listTasks(today,{list:"today",category:"Work"}).map(t=>t.id)).toEqual([c.id,a.id]);
    const old=await taskFiles.loadTaskIndex(root);
    expect(old.all()).toHaveLength(3);
    expect(old.all().every(t=>!("order" in t))).toBe(true);
    expect((await reloaded.readTaskDetails(c.id)).task.order).toBe(store.getTask(c.id)?.order);
    await reloaded.moveTask(c.id,{category:"Work",beforeId:null,today});
    expect(ids(reloaded,"Work")).toEqual([a.id,b.id,c.id]);
    const order=reloaded.getTask(c.id)?.order;
    expect((await reloaded.updateTask(c.id,{title:"Revised"})).order).toBe(order);
    const captured=await reloaded.createTask({title:"New overdue",category:"Work",when:"2026-01-01"});
    await reloaded.rebuild();
    expect(ids(reloaded,"Work")).toEqual([a.id,b.id,c.id,captured.id]);
  });
  it("moves linked and repeated tasks without modifying notes, dates, body or history",async()=>{
    const{root,store}=await notebook();
    const page=await store.createPage(null,"Source");await store.writePage(page.id,"- [ ] Review\nKeep this note\n");
    const text=normalizeTaskText("Review");
    const linked=await store.createTask({title:"Review",category:"Work",page:page.id,anchor:{text,hash:hashTaskText(text),ordinal:0,line:0},body:"Linked notes",relatedPageIds:[page.id]});
    const repeat=await store.createTask({title:"Daily",category:"Work",when:today,deadline:today,repeat:{freq:"daily"},body:"Repeat notes",relatedPageIds:[page.id]});
    const note=await store.readPage(page.id);
    for(const task of [linked,repeat]) {
      const before=await store.readTaskDetails(task.id);
      await store.moveTask(task.id,{category:"Personal",beforeId:null,today});
      const after=await store.readTaskDetails(task.id);
      expect(after).toEqual({...before,task:{...before.task,category:"Personal",updated:after.task.updated,order:after.task.order}});
    }
    expect(await store.readPage(page.id)).toEqual(note);
    expect(await fs.readFile(path.join(root,"_tasks",`${linked.id}.md`),"utf8")).not.toMatch(/^done:|^order:/m);
    await store.moveTask(linked.id,{category:null,beforeId:null,today});
    expect(store.getTask(linked.id)?.category).toBeUndefined();
    expect(store.pageTasks(page.id)[0].order).toBe(store.getTask(linked.id)?.order);
  });
  it("keeps original membership/order when the category write fails, and retries safely",async()=>{
    const{root,store}=await notebook();
    const a=await store.createTask({title:"a",category:"Work",body:"Keep"});
    const b=await store.createTask({title:"b",category:"Work"});
    const target=await store.createTask({title:"target",category:"Other"});
    await store.moveTask(b.id,{category:"Work",beforeId:a.id,today});
    const before=await store.readTaskDetails(b.id);
    const write=taskFiles.writeTaskFile;
    const failure=vi.spyOn(taskFiles,"writeTaskFile").mockImplementation(async(root,task,body)=>{if(task.id===b.id)throw new Error("disk failed");return write(root,task,body);});
    await expect(store.moveTask(b.id,{category:"Other",beforeId:target.id,today})).rejects.toThrow("disk failed");
    expect(await store.readTaskDetails(b.id)).toEqual(before);
    expect(ids(store,"Work")).toEqual([b.id,a.id]);
    failure.mockRestore();
    const reloaded=new Store(root);await reloaded.init();
    expect(await reloaded.readTaskDetails(b.id)).toEqual(before);
    await reloaded.moveTask(b.id,{category:"Other",beforeId:target.id,today});
    expect(ids(reloaded,"Other")).toEqual([b.id,target.id]);
  });
  it("does not change membership or memory when the sidecar cannot be written",async()=>{
    const{store}=await notebook();const task=await store.createTask({title:"a",category:"Work"});
    vi.spyOn(orderFiles,"writeTaskOrder").mockRejectedValue(new Error("disk failed"));
    await expect(store.moveTask(task.id,{category:null,beforeId:null,today})).rejects.toThrow("disk failed");
    expect(store.getTask(task.id)).toEqual(task);
  });
  it("rejects hidden/completed sources and missing, completed or foreign anchors before writing",async()=>{
    const{store,root}=await notebook();const page=await store.createPage(null,"Hidden");await store.writePage(page.id,"- [ ] Hidden\n");
    const text=normalizeTaskText("Hidden");
    const hidden=await store.createTask({title:text,page:page.id,anchor:{text,hash:hashTaskText(text),ordinal:0,line:0}});
    await store.deletePage(page.id);
    const open=await store.createTask({title:"Open",category:"Work"});
    const done=await store.createTask({title:"Done",category:"Work"});await store.updateTask(done.id,{done:true});
    const foreign=await store.createTask({title:"Foreign",category:"Other"});
    for(const id of [hidden.id,done.id]) await expect(store.moveTask(id,{category:"Work",beforeId:null,today})).rejects.toMatchObject({name:"TaskValidationError"});
    for(const beforeId of ["missing",done.id,foreign.id,hidden.id,open.id]) await expect(store.moveTask(open.id,{category:"Work",beforeId,today})).rejects.toMatchObject({name:"TaskValidationError"});
    expect(await orderFiles.readTaskOrder(root)).toEqual({});
  });
  it("serializes moves and preserves the category identity rather than its casing",async()=>{
    const{store}=await notebook();const a=await store.createTask({title:"a",category:"Work"});const b=await store.createTask({title:"b",category:"Work"});const c=await store.createTask({title:"c",category:"Work"});
    await Promise.all([store.moveTask(c.id,{category:" work ",beforeId:a.id,today}),store.moveTask(b.id,{category:"ＷＯＲＫ",beforeId:c.id,today})]);
    expect(ids(store,"Work")).toEqual([b.id,c.id,a.id]);
    expect(store.getTask(b.id)?.category).toBe("Work");
  });
  it("preserves API list, date and evening groups while ordering within each group",async()=>{
    const{store}=await notebook();
    const day=await store.createTask({title:"Day",category:"Work",when:today});
    const evening=await store.createTask({title:"Evening",category:"Work",when:today,evening:true});
    const early=await store.createTask({title:"Early",category:"Work",when:"2026-11-12"});
    const earlySecond=await store.createTask({title:"Early second",category:"Work",when:"2026-11-12"});
    const late=await store.createTask({title:"Late",category:"Work",when:"2026-11-13"});
    await store.moveTask(late.id,{category:"Work",beforeId:day.id,today});
    await store.moveTask(evening.id,{category:"Work",beforeId:day.id,today});
    await store.moveTask(earlySecond.id,{category:"Work",beforeId:early.id,today});
    expect(store.listTasks(today,{offsetMinutes:0}).map(task=>task.id)).toEqual([day.id,evening.id,earlySecond.id,early.id,late.id]);
    expect(store.listTasks(today,{list:"today"}).map(task=>task.id)).toEqual([day.id,evening.id]);
    expect(store.listTasks(today,{list:"upcoming"}).map(task=>task.id)).toEqual([earlySecond.id,early.id,late.id]);
    expect(ids(store,"Work").indexOf(late.id)).toBeLessThan(ids(store,"Work").indexOf(day.id));
  });
});
