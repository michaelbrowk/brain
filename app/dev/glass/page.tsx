import { notFound } from "next/navigation";
import { loadStandTree } from "./fixtures";
import { GlassStand } from "./glass-stand";
import "./stand.css";

export const dynamic = "force-dynamic";

/** Phase 0 dev stand for the Liquid Glass foundations. Development only: in
 *  every other environment the route is a 404. Sits behind the session like
 *  every app route (proxy.ts allowlists nothing under /dev).
 *
 *  The tree is read here rather than inside the stand: the stand is a client
 *  component, so node:fs cannot appear anywhere in its module graph. */
export default function GlassStandPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <GlassStand tree={loadStandTree()} />;
}
