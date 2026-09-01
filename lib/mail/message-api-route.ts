import { BrainMailClientError } from "./brain-mail-client";

export function readThreadListQuery(request: Request): {
  readonly accountId: string;
  readonly cursor?: string;
  readonly limit?: number;
  readonly view?: string;
  readonly sort?: string;
} {
  const search = new URL(request.url).searchParams;
  assertExactQuery(search, ["accountId"], ["cursor", "limit", "view", "sort"]);
  const accountId = search.get("accountId");
  if (accountId === null) throw invalidRequest();
  const cursor = search.get("cursor");
  const rawLimit = search.get("limit");
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) throw invalidRequest();
  const view = search.get("view");
  const sort = search.get("sort");
  return Object.freeze({
    accountId,
    ...(cursor === null ? {} : { cursor }),
    ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
    ...(view === null ? {} : { view }),
    ...(sort === null ? {} : { sort }),
  });
}

export function readAccountQuery(
  request: Request,
  errorCode = "mail_request_invalid",
): string {
  const search = new URL(request.url).searchParams;
  assertExactQuery(search, ["accountId"], [], errorCode);
  const accountId = search.get("accountId");
  if (accountId === null) throw invalidRequest(errorCode);
  return accountId;
}

function assertExactQuery(
  search: URLSearchParams,
  required: readonly string[],
  optional: readonly string[],
  errorCode = "mail_request_invalid",
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = [...search.keys()];
  if (
    required.some((key) => search.getAll(key).length !== 1) ||
    optional.some((key) => search.getAll(key).length > 1) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw invalidRequest(errorCode);
  }
}

function invalidRequest(code = "mail_request_invalid"): BrainMailClientError {
  return new BrainMailClientError(400, code);
}
