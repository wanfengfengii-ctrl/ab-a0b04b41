import { AuditError } from "./errors";
import type { Allele, ParsedVcf, Variant } from "./parser";

/**
 * Trio haplotype transmission audit.
 *
 * A new adjudication segment begins whenever ANY member's PS value changes.
 * Within a segment the child's two ordered haplotypes must each be explained,
 * for the ENTIRE segment without interruption, by exactly one haplotype of one
 * parent:
 *   - child haplotype 1 originates from one parent on one of that parent's
 *     haplotypes,
 *   - child haplotype 2 from the OTHER parent on one of its haplotypes,
 *   - neither the parent of origin nor the selected parental haplotype may
 *     switch mid-segment.
 *
 * At homozygous sites a parental homolog is unobservable, so both homolog
 * choices remain viable there; the set of still-feasible assignments is
 * intersected site by site and the segment fails only when it empties.
 *
 * The first site that cannot satisfy these constraints is reported with a
 * stable reason code:
 *   MENDEL_CONFLICT  - no parental origin assignment can explain the child
 *   ORIGIN_SWITCH    - the parent of origin would have to change
 *   HAPLOTYPE_SWITCH - the chosen parental haplotype would have to change
 */

export type Parent = "father" | "mother";

export interface SiteRef {
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  /** 1-based index across the (aligned) records. */
  index: number;
}

export interface SegmentResult {
  /** 1-based record index of the first site in the segment. */
  startIndex: number;
  /** 1-based record index of the last site in the segment. */
  endIndex: number;
  start: SiteRef;
  end: SiteRef;
  variantCount: number;
  verdict: "consistent" | "inconsistent";
  assignment?: {
    childHaplotype1: { parent: Parent; parentalHaplotype: 1 | 2 };
    childHaplotype2: { parent: Parent; parentalHaplotype: 1 | 2 };
  };
  failure?: {
    index: number;
    site: SiteRef;
    reasonCode: "MENDEL_CONFLICT" | "ORIGIN_SWITCH" | "HAPLOTYPE_SWITCH";
    message: string;
  };
}

export interface AuditReport {
  recordCount: number;
  segments: SegmentResult[];
}

/** A concrete origin for one child haplotype: one haplotype (0|1) of one parent. */
interface Origin {
  parent: Parent;
  hap: 0 | 1;
}

interface Assignment {
  /** Origin of child ordered haplotype 1. */
  o1: Origin;
  /** Origin of child ordered haplotype 2. */
  o2: Origin;
}

export function auditTrio(father: ParsedVcf, mother: ParsedVcf, child: ParsedVcf): AuditReport {
  assertAligned(father, mother, child);

  const n = child.variants.length;
  const segments: SegmentResult[] = [];

  // A boundary exists at record 0 and wherever ANY member's PS changes.
  const boundary = new Array<boolean>(n).fill(false);
  boundary[0] = true;
  for (let i = 1; i < n; i++) {
    boundary[i] =
      father.variants[i]!.ps !== father.variants[i - 1]!.ps ||
      mother.variants[i]!.ps !== mother.variants[i - 1]!.ps ||
      child.variants[i]!.ps !== child.variants[i - 1]!.ps;
  }

  for (let i = 0; i < n; i++) {
    if (!boundary[i]) continue;
    let j = i + 1;
    while (j < n && !boundary[j]) j++;
    // Segment covers zero-based records [i, j).
    segments.push(auditSegment(i, j, father.variants, mother.variants, child.variants));
    i = j - 1;
  }

  return { recordCount: n, segments };
}

function auditSegment(
  startInclusive: number,
  endExclusive: number,
  father: Variant[],
  mother: Variant[],
  child: Variant[],
): SegmentResult {
  const makeBase = (throughExclusive: number): SegmentResult => ({
    startIndex: startInclusive + 1,
    endIndex: throughExclusive,
    start: siteRef(child[startInclusive]!, startInclusive + 1),
    end: siteRef(child[throughExclusive - 1]!, throughExclusive),
    variantCount: throughExclusive - startInclusive,
    verdict: "consistent",
  });

  // Assignments still capable of explaining every site seen so far.
  let candidates: Assignment[] = [];

  for (let k = startInclusive; k < endExclusive; k++) {
    const f = father[k]!;
    const m = mother[k]!;
    const c = child[k]!;

    const compatible = compatibleAssignments(f.hap, m.hap, c.hap);

    if (compatible.length === 0) {
      return {
        ...makeBase(k + 1),
        verdict: "inconsistent",
        failure: {
          index: k + 1,
          site: siteRef(c, k + 1),
          reasonCode: "MENDEL_CONFLICT",
          message:
            `child genotype ${gt(c.hap)} cannot be formed from father ${gt(f.hap)} ` +
            `and mother ${gt(m.hap)} at ${c.chrom}:${c.pos}`,
        },
      };
    }

    const survivors =
      k === startInclusive
        ? compatible
        : candidates.filter((a) => compatible.some((b) => sameAssignment(a, b)));

    if (survivors.length === 0) {
      // No single origin choice covers the whole segment through this site.
      // If some prior candidate could keep child haplotype 1 on the same
      // parent (only swapping to that parent's other homolog) it is a
      // haplotype switch; otherwise the parent of origin itself changes.
      const sameParentPossible = compatible.some((a) =>
        candidates.some((b) => a.o1.parent === b.o1.parent),
      );
      const reasonCode = sameParentPossible ? "HAPLOTYPE_SWITCH" : "ORIGIN_SWITCH";
      return {
        ...makeBase(k + 1),
        verdict: "inconsistent",
        failure: {
          index: k + 1,
          site: siteRef(c, k + 1),
          reasonCode,
          message: failureMessage(reasonCode, c, f, m, candidates[0]!),
        },
      };
    }

    candidates = survivors;
  }

  // candidates is non-empty: every segment holds at least one record.
  const chosen = candidates[0]!;
  return {
    ...makeBase(endExclusive),
    verdict: "consistent",
    assignment: {
      childHaplotype1: {
        parent: chosen.o1.parent,
        parentalHaplotype: (chosen.o1.hap + 1) as 1 | 2,
      },
      childHaplotype2: {
        parent: chosen.o2.parent,
        parentalHaplotype: (chosen.o2.hap + 1) as 1 | 2,
      },
    },
  };
}

/**
 * Every ordered origin assignment (o1 -> child hap1, o2 -> child hap2) that
 * reproduces the child genotype at one site, with one allele from each parent.
 */
function compatibleAssignments(
  fh: [Allele, Allele],
  mh: [Allele, Allele],
  ch: [Allele, Allele],
): Assignment[] {
  const result: Assignment[] = [];
  const paternalAlleles: Array<{ hap: 0 | 1; allele: Allele }> = [
    { hap: 0, allele: fh[0] },
    { hap: 1, allele: fh[1] },
  ];
  const maternalAlleles: Array<{ hap: 0 | 1; allele: Allele }> = [
    { hap: 0, allele: mh[0] },
    { hap: 1, allele: mh[1] },
  ];

  for (const p of paternalAlleles) {
    for (const mm of maternalAlleles) {
      // Child hap1 from father, hap2 from mother.
      if (p.allele === ch[0] && mm.allele === ch[1]) {
        result.push({
          o1: { parent: "father", hap: p.hap },
          o2: { parent: "mother", hap: mm.hap },
        });
      }
      // Child hap1 from mother, hap2 from father.
      if (mm.allele === ch[0] && p.allele === ch[1]) {
        result.push({
          o1: { parent: "mother", hap: mm.hap },
          o2: { parent: "father", hap: p.hap },
        });
      }
    }
  }
  return dedupeAssignments(result);
}

function dedupeAssignments(items: Assignment[]): Assignment[] {
  const seen = new Set<string>();
  const out: Assignment[] = [];
  for (const a of items) {
    const key = `${a.o1.parent}:${a.o1.hap}|${a.o2.parent}:${a.o2.hap}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}

function sameAssignment(a: Assignment, b: Assignment): boolean {
  return (
    a.o1.parent === b.o1.parent &&
    a.o1.hap === b.o1.hap &&
    a.o2.parent === b.o2.parent &&
    a.o2.hap === b.o2.hap
  );
}

function failureMessage(
  code: "ORIGIN_SWITCH" | "HAPLOTYPE_SWITCH",
  c: Variant,
  f: Variant,
  m: Variant,
  previous: Assignment,
): string {
  const where = `${c.chrom}:${c.pos}`;
  if (code === "ORIGIN_SWITCH") {
    return (
      `continuous parent-of-origin transmission breaks at ${where}: child haplotype 1 ` +
      `began with ${previous.o1.parent} haplotype ${previous.o1.hap + 1} but genotype ` +
      `${gt(c.hap)} (father ${gt(f.hap)}, mother ${gt(m.hap)}) forces the other parent`
    );
  }
  return (
    `continuous haplotype transmission breaks at ${where}: within ${previous.o1.parent}, ` +
    `child haplotype 1 began on parental haplotype ${previous.o1.hap + 1} but genotype ` +
    `${gt(c.hap)} (father ${gt(f.hap)}, mother ${gt(m.hap)}) forces the other homolog`
  );
}

function gt(hap: [Allele, Allele]): string {
  return `${hap[0]}|${hap[1]}`;
}

function siteRef(v: Variant, index: number): SiteRef {
  return { chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt, index };
}

/** Structural check: the three files must describe the same sites, in the same order. */
function assertAligned(father: ParsedVcf, mother: ParsedVcf, child: ParsedVcf): void {
  if (
    father.variants.length !== mother.variants.length ||
    father.variants.length !== child.variants.length
  ) {
    throw new AuditError(
      "SITE_COUNT_MISMATCH",
      `record counts differ: father=${father.variants.length}, mother=${mother.variants.length}, child=${child.variants.length}`,
    );
  }

  for (let i = 0; i < child.variants.length; i++) {
    const f = father.variants[i]!;
    const m = mother.variants[i]!;
    const c = child.variants[i]!;
    if (
      f.chrom !== c.chrom ||
      f.pos !== c.pos ||
      f.ref !== c.ref ||
      f.alt !== c.alt ||
      m.chrom !== c.chrom ||
      m.pos !== c.pos ||
      m.ref !== c.ref ||
      m.alt !== c.alt
    ) {
      throw new AuditError(
        "SITES_NOT_ALIGNED",
        `record ${i + 1} is not aligned across the trio: ` +
          `father=${f.chrom}:${f.pos}:${f.ref}>${f.alt} ` +
          `mother=${m.chrom}:${m.pos}:${m.ref}>${m.alt} ` +
          `child=${c.chrom}:${c.pos}:${c.ref}>${c.alt}`,
        { record: i + 1, site: `${c.chrom}:${c.pos}` },
      );
    }
  }
}
