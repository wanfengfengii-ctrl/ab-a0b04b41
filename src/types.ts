/** 已解析的一条 VCF 变异记录。 */
export interface Variant {
  /** 变异在文件中的行序（从 0 起，用于位点对齐报告）。 */
  index: number;
  chrom: string;
  pos: number;
  ref: string;
  alt: string;
  /** 样本基因型两个等位，取值 0（REF）或 1（ALT）。 */
  alleles: readonly [0 | 1, 0 | 1];
  /** 定相标识：'|' 表示已定相。 */
  phased: boolean;
  /** FORMAT 中的相位集（Phase Set）。 */
  ps: string;
}

export type MemberKey = 'father' | 'mother' | 'child';

export interface ParsedVcf {
  member: MemberKey;
  sample: string;
  variants: Variant[];
}

/** 单个裁决区段（任意成员 PS 变化即开启新区段）。 */
export interface AuditSegment {
  /** 区段序号（从 1 起）。 */
  index: number;
  startChrom: string;
  startPos: number;
  endChrom: string;
  endPos: number;
  variantCount: number;
  /** 三位成员在该段各自的 PS 值。 */
  phaseSets: Record<MemberKey, string>;
  verdict: 'CONSISTENT' | 'INCONSISTENT';
  /** 一致时给出固定的亲本单倍型分配；不一致时为 null。 */
  assignment: {
    childHaplotype1: { parent: 'father' | 'mother'; haplotype: 1 | 2 };
    childHaplotype2: { parent: 'father' | 'mother'; haplotype: 1 | 2 };
  } | null;
  /** 首个失败位点（仅 INCONSISTENT 时存在）。 */
  firstFailure: {
    chrom: string;
    pos: number;
    ref: string;
    alt: string;
    reasonCode: string;
    reason: string;
  } | null;
}

export interface AuditResult {
  totalVariants: number;
  segments: AuditSegment[];
}
