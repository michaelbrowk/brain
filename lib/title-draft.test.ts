import { describe, expect, it } from "vitest";
import {
  clearCommittedTitleDrafts,
  normalizeTitle,
  persistTitleDraft,
  recoverTitleDraft,
  titleDraftStorageKey,
} from "./title-draft";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

describe("title draft recovery", () => {
  it("recovers the newest crash draft whose base still matches the server", () => {
    const storage = new MemoryStorage();
    persistTitleDraft(storage, "page", "old-tab", "First edit", "Original", 10);
    persistTitleDraft(storage, "page", "new-tab", "Newest edit", "Original", 20);

    expect(recoverTitleDraft(storage, "page", "Original")).toMatchObject({
      title: "Newest edit",
      baseTitle: "Original",
    });
  });

  it("does not overwrite a title changed by another client", () => {
    const storage = new MemoryStorage();
    persistTitleDraft(storage, "page", "old-tab", "Local edit", "Original", 10);

    expect(recoverTitleDraft(storage, "page", "Remote rename")).toBeNull();
  });

  it("clears only drafts confirmed as the committed title", () => {
    const storage = new MemoryStorage();
    persistTitleDraft(storage, "page", "saved-tab", "  Saved  ", "Original", 10);
    persistTitleDraft(storage, "page", "newer-tab", "Newer edit", "Original", 20);

    clearCommittedTitleDrafts(storage, "page", "Saved");

    expect(storage.getItem(titleDraftStorageKey("page", "saved-tab"))).toBeNull();
    expect(storage.getItem(titleDraftStorageKey("page", "newer-tab"))).not.toBeNull();
  });

  it("normalizes an empty title exactly like the editor", () => {
    expect(normalizeTitle("   ")).toBe("Untitled");
  });
});
