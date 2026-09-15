// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  MAIL_COMMAND_EVENT,
  MAIL_COMMANDS,
  clearComposeRequest,
  emitMailCommand,
  onMailCommand,
  pendingComposeRequest,
  requestCompose,
  subscribeComposeRequest,
} from "./mail-commands";

describe("mail command bus", () => {
  it("delivers every command to a subscribed handler", () => {
    const handler = vi.fn();
    const unsubscribe = onMailCommand(handler);
    for (const command of MAIL_COMMANDS) emitMailCommand(command);
    expect(handler.mock.calls.map(([command]) => command)).toEqual([
      ...MAIL_COMMANDS,
    ]);
    unsubscribe();
  });

  it("stops delivering after unsubscribe", () => {
    const handler = vi.fn();
    const unsubscribe = onMailCommand(handler);
    emitMailCommand("compose");
    unsubscribe();
    emitMailCommand("goto-inbox");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("compose");
  });

  it("ignores events that do not carry a known command", () => {
    const handler = vi.fn();
    const unsubscribe = onMailCommand(handler);
    window.dispatchEvent(new CustomEvent(MAIL_COMMAND_EVENT));
    window.dispatchEvent(
      new CustomEvent(MAIL_COMMAND_EVENT, { detail: "drop-tables" }),
    );
    window.dispatchEvent(
      new CustomEvent(MAIL_COMMAND_EVENT, { detail: { command: "compose" } }),
    );
    expect(handler).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("supports independent subscribers", () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = onMailCommand(first);
    const unsubscribeSecond = onMailCommand(second);
    emitMailCommand("goto-drafts");
    unsubscribeFirst();
    emitMailCommand("goto-people");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    unsubscribeSecond();
  });
});

// THE ASK THAT OUTLIVES THE ROUTE. A command is heard only by a surface that
// is already on screen, and the New menu's Message row is drawn on every one
// of them, so the ask has to wait for Mail to arrive.
describe("the compose request", () => {
  it("stands until it is taken", () => {
    clearComposeRequest();
    expect(pendingComposeRequest()).toBe(false);
    requestCompose();
    expect(pendingComposeRequest()).toBe(true);
    // asked twice before Mail mounted is still one composer
    requestCompose();
    expect(pendingComposeRequest()).toBe(true);
    clearComposeRequest();
    expect(pendingComposeRequest()).toBe(false);
  });

  it("tells a mounted surface at once", () => {
    clearComposeRequest();
    const listener = vi.fn();
    const unsubscribe = subscribeComposeRequest(listener);
    requestCompose();
    expect(listener).toHaveBeenCalledTimes(1);
    clearComposeRequest();
    unsubscribe();
    requestCompose();
    expect(listener).toHaveBeenCalledTimes(1);
    clearComposeRequest();
  });
});
