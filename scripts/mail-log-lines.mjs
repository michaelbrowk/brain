/**
 * The mail service's stderr, read as records.
 *
 * Every non-empty line the service writes there is one JSON record projected
 * onto the section 13 allowlist. A line that is not — a DeprecationWarning
 * from a minor Node release, which `--disable-warning=ExperimentalWarning`
 * does not cover — used to reach `JSON.parse` and fail as a bare SyntaxError
 * with no line to read. It fails by name now, and quotes the line.
 */
export function parseMailLogLines(text) {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(
          `stderr line ${index + 1} is not a mail log record: ${line}`,
        );
      }
    });
}

/**
 * Records in one canonical order, so two lines that raced — two requests in
 * a `Promise.all`, answered in whichever order the service reached them —
 * compare equal as a multiset rather than depending on which finished first.
 */
export function canonicalMailLogRecords(records) {
  return [...records]
    .map((record) => [canonicalJson(record), record])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, record]) => record);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  );
}
