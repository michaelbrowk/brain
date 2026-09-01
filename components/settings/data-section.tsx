"use client";

// Data: backup status, portable export, and the dry-run → apply import.

import { useState } from "react";
import { BackupStatusPanel } from "../backup-status";
import { Button } from "../ui/button";
import { SettingsGroup, SettingsRow, formatPortableBytes } from "./shared";

type PortableSummary = {
  title: string;
  pages: number;
  rootPages: number;
  attachments: number;
  attachmentBytes: number;
  collections: number;
};
type PortableStatus = "idle" | "checking" | "ready" | "applying" | "error" | "done";

export function DataSection({
  onToast,
}: {
  onToast: (title: string) => void;
}) {
  const [portableFile, setPortableFile] = useState<File | null>(null);
  const [portableSummary, setPortableSummary] =
    useState<PortableSummary | null>(null);
  const [portableStatus, setPortableStatus] =
    useState<PortableStatus>("idle");
  const [portableError, setPortableError] = useState<string | null>(null);

  const requestPortableImport = async (
    file: File,
    mode: "dry-run" | "apply",
  ) => {
    setPortableStatus(mode === "apply" ? "applying" : "checking");
    setPortableError(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      const response = await fetch("/api/portable/import", {
        method: "POST",
        body: form,
      });
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        !payload ||
        typeof payload !== "object" ||
        !("summary" in payload) ||
        !payload.summary ||
        typeof payload.summary !== "object"
      ) {
        const error =
          payload &&
          typeof payload === "object" &&
          "error" in payload &&
          typeof payload.error === "string"
            ? payload.error
            : "Couldn't read this archive.";
        throw new Error(error);
      }
      const summary = payload.summary as PortableSummary;
      setPortableSummary(summary);
      setPortableStatus(mode === "apply" ? "done" : "ready");
      if (mode === "apply") onToast(`Imported ${summary.pages} pages`);
    } catch (error) {
      setPortableSummary(null);
      setPortableStatus("error");
      setPortableError(
        error instanceof Error ? error.message : "Couldn't read this archive.",
      );
    }
  };

  return (
    <div className="space-y-7">
      {/* the panel renders its own group: header, refresh action, rows */}
      <BackupStatusPanel onToast={onToast} />
      <SettingsGroup title="Your notes">
        <SettingsRow
          label="Export all notes"
          hint="Downloads Markdown, page structure, and local attachments"
        >
          <a
            href="/api/portable/export"
            download
            className="btn btn-glass tint-hover brain-touch-min"
          >
            Download archive
          </a>
        </SettingsRow>
        <SettingsRow
          label="Import Brain archive"
          hint="Brain checks everything first and always creates new pages"
        >
          <label className="btn btn-glass tint-hover brain-touch-min cursor-pointer">
            Choose archive
            <input
              type="file"
              accept=".gz,.tgz,application/gzip"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                setPortableFile(file);
                void requestPortableImport(file, "dry-run");
              }}
            />
          </label>
        </SettingsRow>
        {(portableStatus === "checking" ||
          portableStatus === "applying") && (
          <p role="status" className="brain-settings-row text-table text-ink-3">
            {portableStatus === "checking"
              ? "Checking archive…"
              : "Importing pages…"}
          </p>
        )}
        {portableStatus === "error" && portableError && (
          <p role="alert" className="brain-settings-row text-table text-ink-2">
            {portableError}
          </p>
        )}
        {portableSummary &&
          (portableStatus === "ready" || portableStatus === "done") && (
            <div className="brain-settings-row" data-stack="">
              <div>
                <p className="text-table font-semibold text-ink">
                  {portableSummary.title}
                </p>
                <p className="mt-0.5 text-caption text-ink-3">
                  {portableSummary.pages} pages ·{" "}
                  {portableSummary.attachments} attachments ·{" "}
                  {formatPortableBytes(portableSummary.attachmentBytes)}
                </p>
              </div>
              {portableStatus === "ready" && portableFile && (
                <Button
                  variant="ink"
                  onClick={() =>
                    void requestPortableImport(portableFile, "apply")
                  }
                >
                  Import new pages
                </Button>
              )}
              {portableStatus === "done" && (
                <p className="text-table text-ink-2">Import complete</p>
              )}
            </div>
          )}
      </SettingsGroup>
    </div>
  );
}
