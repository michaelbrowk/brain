// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hub } from "./hub";

const ACTIVE_CAPTURE_RECORD = "brain-quick-capture-active-record-v3";
const QUICK_CAPTURE_RECORD_PREFIX = "brain-quick-capture-record-v3:";
const QUICK_CAPTURE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const captureRecordKey = (recordId: string) =>
  `${QUICK_CAPTURE_RECORD_PREFIX}${recordId}`;

interface CaptureRecord {
  draft: string;
  idempotencyKey: string;
  attempted: boolean;
  updatedAt: number;
  orphanedAt?: number;
}

function readCaptureRecord(recordId: string): CaptureRecord {
  return JSON.parse(
    localStorage.getItem(captureRecordKey(recordId)) ?? "null",
  ) as CaptureRecord;
}

function seedCaptureRecord(
  recordId: string,
  draft: string,
  idempotencyKey: string,
  updatedAt: number,
  attempted = false,
  orphanedAt?: number,
) {
  localStorage.setItem(
    captureRecordKey(recordId),
    JSON.stringify({
      draft,
      idempotencyKey,
      attempted,
      updatedAt,
      ...(orphanedAt === undefined ? {} : { orphanedAt }),
    }),
  );
}

function captureRecordIds(): string[] {
  const ids: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (key?.startsWith(QUICK_CAPTURE_RECORD_PREFIX)) {
      ids.push(key.slice(QUICK_CAPTURE_RECORD_PREFIX.length));
    }
  }
  return ids.sort();
}

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("Hub quick capture durability", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    // a desktop pointer: the hub's field autofocuses on `(hover: hover)`
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({ matches: query === "(hover: hover)" })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the exact draft until a confirmed page id and ignores double Enter", async () => {
    const first = deferred<string | null>();
    const onCreate = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce("captured-page");
    await act(async () =>
      root.render(<Hub tree={[]} onSelect={() => {}} onCreate={onCreate} />),
    );

    const input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "  exact draft  "));
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate.mock.calls[0][0]).toBe("exact draft");
    expect(onCreate.mock.calls[0][1]).toMatch(
      /^[A-Za-z0-9_-]{16,128}$/,
    );
    expect(input.value).toBe("  exact draft  ");
    expect(input.readOnly).toBe(true);
    expect(input.maxLength).toBe(500);
    const recordId = sessionStorage.getItem(ACTIVE_CAPTURE_RECORD) as string;

    await act(async () => first.resolve(null));
    await settle();

    expect(input.value).toBe("  exact draft  ");
    const operationKey = onCreate.mock.calls[0][1] as string;
    const stored = readCaptureRecord(recordId);
    expect(stored.draft).toBe("  exact draft  ");
    expect(stored.idempotencyKey).toBe(operationKey);
    expect(stored.attempted).toBe(true);

    const retry = container.querySelector(
      'button[aria-label="Retry quick capture"]',
    ) as HTMLButtonElement;
    await act(async () => retry.click());
    await settle();

    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onCreate.mock.calls[1]).toEqual(onCreate.mock.calls[0]);
    expect(input.value).toBe("");
    expect(localStorage.getItem(captureRecordKey(recordId))).toBeNull();
    expect(sessionStorage.getItem(ACTIVE_CAPTURE_RECORD)).toBeNull();
  });

  it("restores an offline draft and its retry identity after reload", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("offline"));
    await act(async () =>
      root.render(<Hub tree={[]} onSelect={() => {}} onCreate={onCreate} />),
    );
    let input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "draft  spacing"));
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();
    const firstKey = onCreate.mock.calls[0][1];
    const firstRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;

    await act(async () => root.unmount());
    root = createRoot(container);
    const retryCreate = vi.fn().mockResolvedValue("same-page");
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={retryCreate} />,
      ),
    );
    await settle();
    const recoveredRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;

    input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("draft  spacing");
    expect(recoveredRecordId).not.toBe(firstRecordId);
    expect(readCaptureRecord(recoveredRecordId).idempotencyKey).toBe(firstKey);
    const retry = container.querySelector(
      'button[aria-label="Retry quick capture"]',
    ) as HTMLButtonElement;
    await act(async () => retry.click());
    await settle();

    expect(retryCreate).toHaveBeenCalledWith("draft  spacing", firstKey);
  });

  it("restores a merely typed draft without showing a false failure", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    let input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "not submitted yet"));

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("not submitted yet");
    expect(
      container.querySelector('button[aria-label="Retry quick capture"]'),
    ).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("recovers the newest valid orphan after a tab loses its pointer", async () => {
    const now = Date.now();
    const olderRecordId = "orphan_older_record_0001";
    const newerRecordId = "orphan_newer_record_0002";
    seedCaptureRecord(
      olderRecordId,
      "older orphan",
      "older_operation_key_0001",
      now - 1_000,
      false,
      now - 1_000,
    );
    seedCaptureRecord(
      newerRecordId,
      "newest orphan",
      "newer_operation_key_0002",
      now,
      false,
      now,
    );

    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    const ownedRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    expect(
      (
        container.querySelector(
          'input[aria-label="New thought"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("newest orphan");
    expect(ownedRecordId).not.toBe(newerRecordId);
    expect(readCaptureRecord(ownedRecordId).draft).toBe("newest orphan");
    expect(localStorage.getItem(captureRecordKey(olderRecordId))).not.toBeNull();
    expect(localStorage.getItem(captureRecordKey(newerRecordId))).toBeNull();
  });

  it("deletes only its owned record when the user explicitly clears the input", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    const input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "clear this"));
    const ownedRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    expect(localStorage.getItem(captureRecordKey(ownedRecordId))).not.toBeNull();

    await act(async () => inputValue(input, ""));

    expect(localStorage.getItem(captureRecordKey(ownedRecordId))).toBeNull();
    expect(sessionStorage.getItem(ACTIVE_CAPTURE_RECORD)).toBeNull();
  });

  it("does not resurrect a superseded reload source after explicit clear", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    let input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "clear after reload"));
    const sourceRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;

    window.dispatchEvent(new Event("pagehide"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();
    const ownedRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    expect(ownedRecordId).not.toBe(sourceRecordId);
    expect(localStorage.getItem(captureRecordKey(sourceRecordId))).toBeNull();

    input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, ""));
    expect(localStorage.getItem(captureRecordKey(ownedRecordId))).toBeNull();

    await act(async () => root.unmount());
    sessionStorage.clear();
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    expect(
      (
        container.querySelector(
          'input[aria-label="New thought"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("");
  });

  it("restores after Hub unmount marks the owned record orphaned", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    const input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "navigate-safe draft"));
    const sourceRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;

    await act(async () => root.unmount());
    expect(readCaptureRecord(sourceRecordId).orphanedAt).toBeTypeOf("number");
    sessionStorage.clear();
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    expect(
      (
        container.querySelector(
          'input[aria-label="New thought"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("navigate-safe draft");
  });

  it("cleans malformed and expired records while preserving valid records", async () => {
    const now = Date.now();
    const activeRecordId = "active_valid_record_0001";
    const expiredRecordId = "expired_record_item_0002";
    const malformedRecordId = "malformed_record_item_0003";
    seedCaptureRecord(
      activeRecordId,
      "active draft",
      "active_operation_key_0001",
      now,
    );
    seedCaptureRecord(
      expiredRecordId,
      "expired draft",
      "expired_operation_key_0002",
      now - QUICK_CAPTURE_TTL_MS - 1,
    );
    localStorage.setItem(captureRecordKey(malformedRecordId), "{not-json");
    localStorage.setItem("unrelated-malformed", "{not-json");
    sessionStorage.setItem(ACTIVE_CAPTURE_RECORD, activeRecordId);

    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    expect(localStorage.getItem(captureRecordKey(expiredRecordId))).toBeNull();
    expect(localStorage.getItem(captureRecordKey(malformedRecordId))).toBeNull();
    expect(localStorage.getItem("unrelated-malformed")).toBe("{not-json");
    expect(localStorage.getItem(captureRecordKey(activeRecordId))).not.toBeNull();
  });

  it("bounds reload clones by expiring all stale records after 30 days", async () => {
    const now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    let input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "bounded clone"));

    for (let reload = 0; reload < 3; reload += 1) {
      await act(async () => root.unmount());
      root = createRoot(container);
      await act(async () =>
        root.render(
          <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
        ),
      );
      await settle();
    }
    // Each reload supersedes and removes its pagehide-marked source, so reload
    // cloning itself is bounded to the one currently owned record.
    expect(captureRecordIds()).toHaveLength(1);

    await act(async () => root.unmount());
    sessionStorage.clear();
    vi.mocked(Date.now).mockReturnValue(now + QUICK_CAPTURE_TTL_MS + 1);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();
    input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;

    expect(input.value).toBe("");
    expect(captureRecordIds()).toEqual([]);
    expect(sessionStorage.getItem(ACTIVE_CAPTURE_RECORD)).toBeNull();
  });

  it("forks a copy-inherited draft before two tabs diverge", async () => {
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    const firstInput = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(firstInput, "shared draft"));
    const firstRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;

    const secondContainer = document.createElement("div");
    document.body.appendChild(secondContainer);
    const secondRoot = createRoot(secondContainer);
    await act(async () =>
      secondRoot.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();
    const secondRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    const secondInput = secondContainer.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    expect(secondInput.value).toBe("shared draft");
    expect(secondRecordId).not.toBe(firstRecordId);

    await act(async () => inputValue(secondInput, "draft from copied tab"));
    const secondKey = readCaptureRecord(secondRecordId).idempotencyKey;

    sessionStorage.setItem(ACTIVE_CAPTURE_RECORD, firstRecordId);
    await act(async () => inputValue(firstInput, "draft from original tab"));
    const firstKey = readCaptureRecord(firstRecordId).idempotencyKey;
    expect(secondKey).not.toBe(firstKey);

    expect(readCaptureRecord(firstRecordId).draft).toBe(
      "draft from original tab",
    );
    expect(readCaptureRecord(secondRecordId).draft).toBe(
      "draft from copied tab",
    );

    await act(async () => secondRoot.unmount());
    secondContainer.remove();
  });

  it("keeps the original tab recoverable when an unchanged duplicate submits", async () => {
    const originalCreate = vi.fn();
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={originalCreate} />,
      ),
    );
    const originalInput = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(originalInput, "shared K"));
    const originalRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    const sharedKey = readCaptureRecord(originalRecordId).idempotencyKey;

    const duplicateContainer = document.createElement("div");
    document.body.appendChild(duplicateContainer);
    const duplicateRoot = createRoot(duplicateContainer);
    const duplicateCreate = vi.fn().mockResolvedValue("shared-page");
    await act(async () =>
      duplicateRoot.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={duplicateCreate} />,
      ),
    );
    await settle();
    const duplicateRecordId = sessionStorage.getItem(
      ACTIVE_CAPTURE_RECORD,
    ) as string;
    const duplicateInput = duplicateContainer.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    expect(duplicateRecordId).not.toBe(originalRecordId);
    expect(readCaptureRecord(duplicateRecordId).idempotencyKey).toBe(sharedKey);

    // Switch the jsdom session pointer back to the original tab. Real tabs
    // already have isolated sessionStorage instances.
    sessionStorage.setItem(ACTIVE_CAPTURE_RECORD, originalRecordId);
    await act(async () =>
      inputValue(originalInput, "original divergent draft"),
    );
    const divergentKey =
      readCaptureRecord(originalRecordId).idempotencyKey;
    expect(divergentKey).not.toBe(sharedKey);

    // Switch to the duplicate tab's isolated pointer and submit unchanged.
    sessionStorage.setItem(ACTIVE_CAPTURE_RECORD, duplicateRecordId);
    await act(async () => {
      duplicateInput.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();

    expect(duplicateCreate).toHaveBeenCalledWith("shared K", sharedKey);
    expect(originalCreate).not.toHaveBeenCalled();
    expect(localStorage.getItem(captureRecordKey(duplicateRecordId))).toBeNull();
    expect(readCaptureRecord(originalRecordId)).toMatchObject({
      draft: "original divergent draft",
      idempotencyKey: divergentKey,
      attempted: false,
    });

    await act(async () => duplicateRoot.unmount());
    duplicateContainer.remove();
    await act(async () => root.unmount());
    sessionStorage.setItem(ACTIVE_CAPTURE_RECORD, originalRecordId);
    root = createRoot(container);
    await act(async () =>
      root.render(
        <Hub tree={[]} onSelect={() => {}} onCreate={vi.fn()} />,
      ),
    );
    await settle();

    expect(
      (
        container.querySelector(
          'input[aria-label="New thought"]',
        ) as HTMLInputElement
      ).value,
    ).toBe("original divergent draft");
  });

  it("does not claim a failed draft is safe when browser storage rejects it", async () => {
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (this === window.localStorage) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      return originalSetItem.call(this, key, value);
    });
    const onCreate = vi.fn().mockRejectedValue(new Error("offline"));
    await act(async () =>
      root.render(<Hub tree={[]} onSelect={() => {}} onCreate={onCreate} />),
    );
    const input = container.querySelector(
      'input[aria-label="New thought"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "memory only"));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Keep this tab open — local recovery is unavailable.",
    );
    expect(container.textContent).not.toContain("draft is safe");

    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Keep this tab open — local recovery is unavailable.",
    );
    expect(container.textContent).not.toContain("draft is safe");
  });
});
