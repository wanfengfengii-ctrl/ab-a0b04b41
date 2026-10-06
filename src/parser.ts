import { AuditError } from "./errors";

/**
 * Minimal, strict VCF 4.2 reader.
 *
 * Accepts exactly one sample column with FORMAT `GT:PS`, diploid biallelic
 * phased SNP records whose (CHROM, POS, REF, ALT) coordinates are strictly
 * increasing. Anything else is a structural rejection.
 */

export type Member = "father" | "mother" | "child";

/** Allele index into [REF, ALT], 0 = reference, 1 = alternate. */
export type Allele = 0 | 1;

export interface Variant {
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  /** Paternal/maternal-style ordered haplotype alleles: [h1, h2]. */
  hap: [Allele, Allele];
  /** Raw PS value, as printed in the file. */
  ps: string;
}

export interface ParsedVcf {
  member: Member;
  variants: Variant[];
}

const MEMBER_NAME: Record<Member, string> = {
  father: "father",
  mother: "mother",
  child: "child",
};

const MAX_RECORDS = 2000;
const SNP_BASE = /^[ACGT]$/;

export function parseVcf(text: string, member: Member): ParsedVcf {
  if (text.length === 0) {
    throw new AuditError("INVALID_FILE", `${member} is empty`, { member });
  }

  // Normalise CRLF / CR so line splitting is deterministic.
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  let sawFileformat = false;
  let sampleColumn: string[] | null = null;
  const variants: Variant[] = [];

  let prev: { chrom: string; pos: number; ref: string; alt: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.trimEnd();
    if (line === "") continue;

    if (line.startsWith("#")) {
      if (line.startsWith("##fileformat=")) {
        const value = line.slice("##fileformat=".length).trim();
        if (value !== "VCF4.2" && value !== "VCFv4.2") {
          throw new AuditError(
            "UNSUPPORTED_VCF_VERSION",
            `${member}: only VCF 4.2 is accepted (found ${value})`,
            { member },
          );
        }
        sawFileformat = true;
      } else if (line.startsWith("#CHROM")) {
        const cols = line.split("\t");
        if (cols.length < 8) {
          throw new AuditError("INVALID_FILE", `${member}: malformed VCF header`, {
            member,
          });
        }
        // cols[0..7] = #CHROM POS ID REF ALT QUAL FILTER INFO, then FORMAT, then samples
        if (cols.length === 8) {
          throw new AuditError(
            "SAMPLE_COUNT_MISMATCH",
            `${member}: expected exactly one sample column, found none`,
            { member },
          );
        }
        if (cols.length !== 10) {
          throw new AuditError(
            "SAMPLE_COUNT_MISMATCH",
            `${member}: expected exactly one sample column, found ${cols.length - 9}`,
            { member },
          );
        }
        sampleColumn = [cols[8]!, cols[9]!];
      }
      continue;
    }

    if (!sawFileformat) {
      throw new AuditError(
        "UNSUPPORTED_VCF_VERSION",
        `${member}: missing ##fileformat=VCFv4.2 header line`,
        { member },
      );
    }
    if (!sampleColumn) {
      throw new AuditError("INVALID_FILE", `${member}: data record before #CHROM header`, {
        member,
      });
    }

    const recordIndex = variants.length + 1;
    const cols = line.split("\t");
    if (cols.length !== 10) {
      throw new AuditError(
        "INVALID_FILE",
        `${member}: record ${recordIndex} must have 10 tab-separated columns`,
        { member, record: recordIndex },
      );
    }

    const [chrom, posStr, id, ref, alt, qual, filter, info, format, sample] =
      cols as [string, string, string, string, string, string, string, string, string, string];
    void id;
    void qual;
    void filter;
    void info;

    if (format !== "GT:PS") {
      throw new AuditError(
        "UNSUPPORTED_FORMAT",
        `${member}: record ${recordIndex} FORMAT must be exactly GT:PS (found ${format})`,
        { member, record: recordIndex },
      );
    }

    const pos = Number(posStr);
    if (!Number.isInteger(pos) || pos <= 0) {
      throw new AuditError(
        "INVALID_FILE",
        `${member}: record ${recordIndex} has invalid POS '${posStr}'`,
        { member, record: recordIndex },
      );
    }

    if (!SNP_BASE.test(ref) || !SNP_BASE.test(alt)) {
      throw new AuditError(
        "UNSUPPORTED_VARIANT",
        `${member}: record ${recordIndex} is not a biallelic SNP (REF=${ref} ALT=${alt})`,
        { member, record: recordIndex, site: `${chrom}:${pos}` },
      );
    }

    const sampleFields = sample.split(":");
    if (sampleFields.length !== 2) {
      throw new AuditError(
        "INVALID_GENOTYPE",
        `${member}: record ${recordIndex} sample must carry GT:PS only`,
        { member, record: recordIndex, site: `${chrom}:${pos}` },
      );
    }
    const [gt, ps] = sampleFields as [string, string];

    if (ps === "" || ps === "." || !/^[0-9]+$/.test(ps)) {
      throw new AuditError(
        "INVALID_PHASE_SET",
        `${member}: record ${recordIndex} has missing or non-integer PS '${ps}'`,
        { member, record: recordIndex, site: `${chrom}:${pos}` },
      );
    }

    const hap = parsePhasedGt(gt, member, recordIndex, chrom, pos);

    // Strict coordinate ordering: CHROM, then POS, then REF, then ALT.
    if (prev) {
      const order = compareCoordinate(prev, { chrom, pos, ref, alt });
      if (order >= 0) {
        throw new AuditError(
          "INVALID_FILE",
          `${member}: records must be strictly increasing by CHROM,POS,REF,ALT ` +
            `(record ${recordIndex} ${chrom}:${pos}:${ref}>${alt} is not after ` +
            `${prev.chrom}:${prev.pos}:${prev.ref}>${prev.alt})`,
          { member, record: recordIndex, site: `${chrom}:${pos}` },
        );
      }
    }
    prev = { chrom, pos, ref, alt };

    variants.push({ chrom, pos, ref, alt, hap, ps });

    if (variants.length > MAX_RECORDS) {
      throw new AuditError(
        "TOO_MANY_RECORDS",
        `${member}: exceeds the limit of ${MAX_RECORDS} records`,
        { member },
      );
    }
  }

  if (!sawFileformat) {
    throw new AuditError(
      "UNSUPPORTED_VCF_VERSION",
      `${member}: missing ##fileformat=VCFv4.2 header line`,
      { member },
    );
  }
  if (variants.length === 0) {
    throw new AuditError("EMPTY_VCF", `${MEMBER_NAME[member]} VCF contains no records`, {
      member,
    });
  }

  return { member, variants };
}

function parsePhasedGt(
  gt: string,
  member: Member,
  recordIndex: number,
  chrom: string,
  pos: number,
): [Allele, Allele] {
  // Diploid, fully phased, complete: e.g. 0|1. Phasing must use '|'.
  const match = /^([01])\|([01])$/.exec(gt);
  if (!match) {
    throw new AuditError(
      "INVALID_GENOTYPE",
      `${member}: record ${recordIndex} genotype '${gt}' must be a complete phased diploid biallelic GT (0|0, 0|1, 1|0, 1|1)`,
      { member, record: recordIndex, site: `${chrom}:${pos}` },
    );
  }
  return [Number(match[1]) as Allele, Number(match[2]) as Allele];
}

interface Coordinate {
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
}

/** Coordinate comparison following the required CHROM, POS, REF, ALT ordering. */
function compareCoordinate(a: Coordinate, b: Coordinate): number {
  if (a.chrom !== b.chrom) return a.chrom < b.chrom ? -1 : 1;
  if (a.pos !== b.pos) return a.pos - b.pos;
  if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
  if (a.alt !== b.alt) return a.alt < b.alt ? -1 : 1;
  return 0;
}
