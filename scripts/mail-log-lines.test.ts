import { describe, expect, it } from "vitest";

import { canonicalMailLogRecords, parseMailLogLines } from "./mail-log-lines.mjs";

describe("mail service log lines", () => {
  it("parses one record per non-empty line", () => {
    expect(parseMailLogLines('{"event":"a"}\n\n{"event":"b"}\n')).toEqual([
      { event: "a" },
      { event: "b" },
    ]);
  });

  /*
    The smoke fed every stderr line to JSON.parse. A line that is not a record
    — a DeprecationWarning from a minor Node release, which
    `--disable-warning=ExperimentalWarning` does not cover — failed as a bare
    SyntaxError from inside the parser, with no line to read. The failure is
    named and quotes the line.
  */
  it("fails by name, quoting the line that is not a record", () => {
    const text =
      '{"event":"a"}\n(node:42) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n';

    expect(() => parseMailLogLines(text)).toThrow(
      /^stderr line 2 is not a mail log record: \(node:42\) \[DEP0040\] DeprecationWarning/,
    );
    expect(() => parseMailLogLines(text)).not.toThrow(SyntaxError);
  });

  /*
    Two requests raced in `Promise.all` write their records in whichever order
    the service answered. A second expected line would have made `deepEqual`
    depend on that order; the records compare as a multiset instead.
  */
  it("orders records so lines that raced compare equal, whatever their key order", () => {
    const first = { event: "mail_request_failed", phase: "a", errorCode: "x" };
    const second = { errorCode: "y", event: "mail_request_failed", phase: "b" };

    expect(canonicalMailLogRecords([first, second])).toEqual(
      canonicalMailLogRecords([
        { phase: "b", errorCode: "y", event: "mail_request_failed" },
        first,
      ]),
    );
    expect(canonicalMailLogRecords([first, first])).not.toEqual(
      canonicalMailLogRecords([first]),
    );
  });
});
