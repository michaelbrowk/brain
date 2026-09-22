"use client";

// WHETHER THERE IS ANYWHERE TO SEND FROM.
//
// The New menu offers a message, and a menu row that opens a composer for no
// account is a row that can only apologise. So the row is absent rather than
// dimmed, and this is the one fact that decides it: does any connected account
// carry both `compose` and `send`. It is the same test the mail surface runs
// before it starts a blank composer (`firstComposeAccount`), asked one screen
// earlier.
//
// ONE ANSWER PER CLIENT, SHARED. The menu is mounted in the sidebar head and
// under the phone's plus, and both are drawn on every surface, so a hook that
// fetched per mount would ask on every route. The answer is a module value
// with a subscriber set: the first mount asks, every later one reads, and a
// tab that connects an account in Settings picks it up on its next load. A
// false answer costs one absent row, never a wrong composer: the surface
// checks capabilities again before it opens one.
//
// The memo is keyed by the client that was asked, and that key is what makes
// the Mail switch work. With Mail off the menu hands this hook a client that
// answers "no accounts" without a request, so nothing reaches a route that is
// about to 409. Memoised on the first ask alone, that "no" then outlived the
// switch: a tab booted with Mail off kept the Message row hidden after the
// owner turned Mail back on, until they reloaded. A different client is a
// different question, so it is asked again.
//
// A REFUSAL IS A NO. The mail service is another process and can be down; with
// no answer there is no account to name and no composer to promise, which is
// the same row the no-account case draws, which is none.

import { useEffect, useState } from "react";

import {
  defaultMailSurfaceClient,
  type MailSurfaceClient,
  type PublicMailAccount,
} from "./mail-surface-client";

let answer = false;
let asked: Promise<void> | null = null;
/** Which client `asked` was asked of. Module values, compared by identity:
 *  `defaultMailSurfaceClient` and the menu's no-accounts stand-in are each one
 *  object for the life of the process. */
let askedClient: Pick<MailSurfaceClient, "loadAccounts"> | null = null;
const listeners = new Set<() => void>();

function publish(next: boolean): void {
  if (answer === next) return;
  answer = next;
  for (const listener of listeners) listener();
}

function canSend(account: PublicMailAccount): boolean {
  return account.capabilities.compose && account.capabilities.send;
}

async function ask(client: Pick<MailSurfaceClient, "loadAccounts">): Promise<void> {
  try {
    publish((await client.loadAccounts()).some(canSend));
  } catch {
    publish(false);
  }
}

/** Reset between tests: the module value outlives a render root. */
export function resetMailComposeAvailable(): void {
  answer = false;
  asked = null;
  askedClient = null;
  listeners.clear();
}

export function useMailComposeAvailable(
  client: Pick<MailSurfaceClient, "loadAccounts"> = defaultMailSurfaceClient,
): boolean {
  const [available, setAvailable] = useState(answer);
  useEffect(() => {
    const read = () => setAvailable(answer);
    listeners.add(read);
    read();
    if (asked === null || askedClient !== client) {
      askedClient = client;
      asked = ask(client);
    }
    void asked.then(read);
    return () => {
      listeners.delete(read);
    };
  }, [client]);
  return available;
}
