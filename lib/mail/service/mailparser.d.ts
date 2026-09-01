declare module "mailparser" {
  import type { Transform } from "node:stream";

  export interface MailParserOptions {
    readonly checksumAlgo?: string;
    readonly keepCidLinks?: boolean;
    readonly skipHtmlToText?: boolean;
    readonly maxHtmlLengthToParse?: number;
    readonly maxHeadSize?: number;
    readonly maxChildNodes?: number;
    readonly maxTotalHeadSize?: number;
    readonly maxNestingDepth?: number;
    readonly maxLineSize?: number;
    readonly maxDecodedBytes?: number;
    readonly maxHtmlCharacters?: number;
    readonly maxTextCharacters?: number;
  }

  export class MailParser extends Transform {
    constructor(options?: MailParserOptions);
  }
}
