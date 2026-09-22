import { readModules } from "@/lib/owner-settings";
import { createBrainMailClient, type BrainMailClient } from "./brain-mail-client";

/** THE ONE SENTENCE BRAIN SAYS TO THE MAIL SERVICE ABOUT THE SWITCH.
 *
 *  Said twice: when the switch flips, and once at startup. The second is not
 *  belt and braces, it is the repair. The service restarts on its own
 *  (`Restart=on-failure`, and socket activation after an idle stop), and a
 *  portable restore can land a settings file next to a service that never
 *  heard about it; the two would otherwise disagree until somebody touched
 *  the switch again. The persisted flag inside the service is what makes the
 *  common case correct, and this is what re-syncs the uncommon one.
 *
 *  A failure is a `false`, never a throw: the switch is the owner's and the
 *  settings file is the truth. Nothing about mail is logged beyond the
 *  service not answering, which the mail scan already says in the same words.
 *
 *  Answers whether the service took it.
 */
export async function tellMailServiceAboutModules(
  client: Pick<BrainMailClient, "setSyncEnabled"> = createBrainMailClient(),
): Promise<boolean> {
  try {
    await client.setSyncEnabled((await readModules()).mail);
    return true;
  } catch {
    return false;
  }
}
