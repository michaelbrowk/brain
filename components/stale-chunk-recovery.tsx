"use client";

import { useEffect } from "react";
import {
  listenForStaleChunks,
  settleStaleChunkRecovery,
} from "@/lib/stale-chunk";

/** Mounted once in the root layout, so it is part of every document's first
 *  chunk set and cannot itself go stale. Settles the reload guard for this
 *  URL, then watches for the chunk failures no boundary sees (see
 *  `lib/stale-chunk.ts`). Nothing else: the surfaces this protects are the
 *  ones it must not depend on. */
export function StaleChunkRecovery() {
  useEffect(() => {
    settleStaleChunkRecovery();
    return listenForStaleChunks(window);
  }, []);
  return null;
}
