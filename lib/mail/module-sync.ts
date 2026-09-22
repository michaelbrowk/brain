import type { ModuleSwitches } from "@/lib/modules";
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
 *  THE FLIP HANDS OVER WHAT IT WROTE. `modules` is the pair the route just
 *  saved, so the value on the wire is that write rather than a second read of
 *  the file that happens to follow it. Only the startup reconcile reads,
 *  because at boot there is no write to carry and the file is the only truth
 *  there is.
 *
 *  A FAILURE IS A `false`, NEVER A THROW, and the client is built inside the
 *  try for exactly that reason. `createBrainMailClient` throws on a malformed
 *  `BRAIN_MAIL_SOCKET_PATH`, an empty one included, which is how an operator
 *  unsets a variable in a drop-in. As a default parameter that throw ran
 *  before the body and escaped the catch: the PUT answered 500 on a switch it
 *  had already written, and the startup call rejected with nothing listening
 *  for it. The switch is the owner's and the settings file is the truth;
 *  neither may depend on another process answering, or on the path to it
 *  being well formed.
 *
 *  Answers whether the service took it.
 */
export async function tellMailServiceAboutModules(
  options: {
    /** The pair the caller just wrote. Omitted at startup, where the file is
     *  read instead. */
    readonly modules?: ModuleSwitches;
    readonly client?: Pick<BrainMailClient, "setSyncEnabled">;
  } = {},
): Promise<boolean> {
  try {
    const mail = options.modules
      ? options.modules.mail
      : (await readModules()).mail;
    const client = options.client ?? createBrainMailClient();
    await client.setSyncEnabled(mail);
    return true;
  } catch {
    return false;
  }
}
