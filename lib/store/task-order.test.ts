import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTaskOrder, writeTaskOrder } from "./task-order";
const roots:string[]=[];
async function root(){const p=await fs.mkdtemp(path.join(os.tmpdir(),"brain-order-sidecar-"));roots.push(p);return p;}
afterEach(async()=>{await Promise.all(roots.splice(0).map(p=>fs.rm(p,{recursive:true,force:true})));});
describe("task order sidecar",()=>{
  it("reads missing as empty, atomically round-trips categories and keeps handwritten body",async()=>{
    const p=await root();expect(await readTaskOrder(p)).toEqual({});
    await writeTaskOrder(p,{work:{task:"a0"},"":{other:"a1"}});
    const file=path.join(p,"_tasks","_order","index.md");await fs.appendFile(file,"Keep this explanation\n");
    await writeTaskOrder(p,{work:{task:"a2"}});
    expect(await readTaskOrder(p)).toEqual({work:{task:"a2"}});expect(await fs.readFile(file,"utf8")).toContain("Keep this explanation\n");
  });
  it("rejects bad ranks and symlink directories/files",async()=>{
    const p=await root();await expect(writeTaskOrder(p,{work:{task:"!invalid"}})).rejects.toThrow();
    await fs.mkdir(path.join(p,"_tasks"));const outside=await root();await fs.symlink(outside,path.join(p,"_tasks","_order"));
    await expect(writeTaskOrder(p,{work:{task:"a0"}})).rejects.toThrow();
    await expect(readTaskOrder(p)).rejects.toThrow();
  });
  it("refuses an existing symbolic-link index without changing its target",async()=>{
    const p=await root();await fs.mkdir(path.join(p,"_tasks","_order"),{recursive:true});const outside=path.join(await root(),"keep.md");await fs.writeFile(outside,"Keep");
    await fs.symlink(outside,path.join(p,"_tasks","_order","index.md"));
    await expect(writeTaskOrder(p,{work:{task:"a0"}})).rejects.toThrow("symbolic link");
    await expect(readTaskOrder(p)).rejects.toThrow("symbolic link");expect(await fs.readFile(outside,"utf8")).toBe("Keep");
  });
  it("round-trips category names and ids that match prototype properties",async()=>{
    const p=await root();
    const expected=Object.fromEntries([["__proto__",Object.fromEntries([["__proto__","a0"],["constructor","a1"]])]]);
    await writeTaskOrder(p,expected);
    const actual=await readTaskOrder(p);
    expect(Object.hasOwn(actual,"__proto__")).toBe(true);
    expect(actual).toEqual(expected);
    await expect(writeTaskOrder(p,Object.fromEntries([["__proto__",{task:"!invalid"}]]))).rejects.toThrow();
  });
});
