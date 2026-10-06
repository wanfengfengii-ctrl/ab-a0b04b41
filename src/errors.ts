/**
 * Stable error reason codes for the trio audit API.
 *
 * Structural problems (file format / site alignment) reject the whole request
 * with HTTP 400. Per-site genetic or phasing inconsistencies are reported on
 * the relevant segment with HTTP 200 (the audit ran successfully; the trio
 * simply does not pass).
 */
export type ReasonCode =
  // Structural / alignment failures -> whole request rejected (HTTP 400)
  | "INVALID_FILE"
  | "UNSUPPORTED_VCF_VERSION"
  | "UNSUPPORTED_VARIANT"
  | "INVALID_GENOTYPE"
  | "INVALID_PHASE_SET"
  | "UNSUPPORTED_FORMAT"
  | "SAMPLE_COUNT_MISMATCH"
  | "SITE_COUNT_MISMATCH"
  | "SITES_NOT_ALIGNED"
  | "EMPTY_VCF"
  | "TOO_MANY_RECORDS"
  | "FILE_TOO_LARGE"
  | "MISSING_FILE"
  // Per-site audit failures -> reported on a segment (HTTP 200)
  | "MENDEL_CONFLICT"
  | "ORIGIN_SWITCH"
  | "HAPLOTYPE_SWITCH";

export class AuditError extends Error {
  readonly code: ReasonCode;
  /** 1-based record index within the offending member file, when applicable. */
  readonly record?: number;
  /** Which member triggered the error, when applicable. */
  readonly member?: "father" | "mother" | "child";
  /** CHROM:POS of the offending site, when applicable. */
  readonly site?: string;

  constructor(
    code: ReasonCode,
    message: string,
    detail?: {
      record?: number;
      member?: "father" | "mother" | "child";
      site?: string;
    },
  ) {
    super(message);
    this.name = "AuditError";
    this.code = code;
    if (detail) {
      if (detail.record !== undefined) this.record = detail.record;
      if (detail.member !== undefined) this.member = detail.member;
      if (detail.site !== undefined) this.site = detail.site;
    }
  }
}
