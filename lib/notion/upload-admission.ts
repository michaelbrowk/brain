export class NotionUploadAdmission {
  private active = false;

  tryAcquire(): (() => void) | null {
    if (this.active) return null;
    this.active = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = false;
    };
  }
}

const globalAdmission = globalThis as unknown as {
  __brainNotionUploadAdmission?: NotionUploadAdmission;
};

/** Base64 MCP payloads are large. Admit one decode at a time and make callers
 *  retry instead of retaining a queue of 25 MB buffers on the 2 GB host. */
export function acquireNotionUploadSlot(): (() => void) | null {
  if (!globalAdmission.__brainNotionUploadAdmission) {
    globalAdmission.__brainNotionUploadAdmission = new NotionUploadAdmission();
  }
  return globalAdmission.__brainNotionUploadAdmission.tryAcquire();
}
