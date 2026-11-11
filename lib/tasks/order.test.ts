import { describe, expect, it } from "vitest";
import type { TaskView } from "./model";
import { compareTaskOrder, planTaskMove, taskMoveSchema } from "./order";
const today = "2026-11-11";
const task = (id: string, fields: Partial<TaskView> = {}): TaskView => ({id,title:id,done:false,created:`2026-10-01T00:00:0${id.charCodeAt(0) % 10}.000Z`,updated:"2026-10-01T00:00:00.000Z", category:"Work",...fields});
const sorted = (tasks: TaskView[]) => tasks.toSorted((a,b) => compareTaskOrder(a,b,today)).map(t=>t.id);

describe("task placement projection", () => {
  it("keeps filter-hidden siblings and uses one category order for every view", () => {
    const tasks=[task("a",{when:today}),task("b",{when:"2026-12-01"}),task("c",{when:today}),task("d")];
    const moved=planTaskMove(tasks,"d",{category:"Work",beforeId:"c",today});
    expect(sorted(moved.tasks)).toEqual(["a","b","d","c"]);
    expect(sorted(moved.tasks.filter(t=>t.when===today))).toEqual(["a","c"]);
    expect(sorted(planTaskMove(moved.tasks,"a",{category:"Work",beforeId:null,today}).tasks)).toEqual(["b","d","c","a"]);
  });
  it("freezes legacy overdue-first placement and keeps later captures after manual order", () => {
    const tasks=[task("a"),task("b",{when:"2026-11-01"}),task("c")];
    const moved=planTaskMove(tasks,"c",{category:"Work",beforeId:"b",today});
    expect(sorted([...moved.tasks,task("d",{when:"2026-01-01"})])).toEqual(["c","b","a","d"]);
  });
  it("preserves unrelated fields, clears a category, and leaves other categories untouched", () => {
    const source=task("a",{repeat:{freq:"daily"},when:today,deadline:today,relatedPageIds:["page"],log:[]});
    const other=task("b",{category:"Elsewhere"});
    const result=planTaskMove([source,other],source.id,{category:null,beforeId:null,today});
    expect(result.task).toEqual({...source,category:undefined,order:expect.any(String)});
    expect(result.tasks[1]).toBe(other);
  });
  it("does not treat inherited object properties as task positions", () => {
    const other=task("constructor",{category:"Other"});
    expect(planTaskMove([task("a"),other],"a",{category:"Work",beforeId:null,today}).tasks[1]).toBe(other);
  });
  it.each(["missing","done","self","other-category"])("refuses %s anchors and unavailable sources", kind => {
    const tasks=[task("a"),task("b",{done:kind==="done",category:kind==="other-category"?"Else":"Work"})];
    expect(()=>planTaskMove(tasks,"a",{category:"Work",beforeId:kind==="self"?"a":kind==="missing"?"gone":"b",today})).toThrow();
    expect(()=>planTaskMove(tasks,"missing",{category:null,beforeId:null,today})).toThrow();
    expect(()=>planTaskMove([task("a",{done:true})],"a",{category:null,beforeId:null,today})).toThrow();
  });
  it.each(["2026-02-30","someday","",null])("rejects invalid day %j", value => {
    expect(taskMoveSchema.safeParse({category:null,beforeId:null,today:value}).success).toBe(false);
  });
  it("normalizes categories and refuses unknown or malformed fields",()=>{
    expect(taskMoveSchema.parse({category:"  Ｗｏｒｋ  ",beforeId:null,today}).category).toBe("Work");
    for(const extra of [{category:"  "},{beforeId:"../x"},{when:today},{order:"a0"}]) expect(taskMoveSchema.safeParse({category:null,beforeId:null,today,...extra}).success).toBe(false);
  });
});
