export interface MailContentAttachmentDto {
  readonly attachmentId: string;
  readonly filename: string | null;
  readonly mimeType: string;
  readonly disposition: "attachment" | "inline";
  readonly contentId: string | null;
  readonly bytes: number;
}

export const MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY =
  "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'";

/** Keeps two concurrent decoded inline images within a mobile memory budget. */
export const MAIL_INLINE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

interface MailMessageContentBase {
  readonly apiVersion: 1;
  readonly accountId: string;
  readonly messageId: string;
}

export type MailMessageContent =
  | (MailMessageContentBase & { readonly state: "not_requested" })
  | (MailMessageContentBase & { readonly state: "fetching" })
  | (MailMessageContentBase & { readonly state: "transient" })
  | (MailMessageContentBase & { readonly state: "permanent" })
  | (MailMessageContentBase & {
      readonly state: "ready";
      readonly textBody: string | null;
      readonly htmlBody: string | null;
      readonly attachments: readonly MailContentAttachmentDto[];
    });
