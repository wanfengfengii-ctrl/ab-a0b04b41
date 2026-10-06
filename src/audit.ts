import { badRequest } from './errors.js';
import { compareLoci, parseVcf } from './parser.js';
import type {
  AuditResult,
  AuditSegment,
  MemberKey,
  ParsedVcf,
  Variant,
} from './types.js';

const MEMBERS: readonly MemberKey[] = ['father', 'mother', 'child'];

interface AlignedRow {
  locus: { chrom: string; pos: number; ref: string; alt: string };
  records: Record<MemberKey, Variant>;
}

/** 校验三份文件的记录数与 (CHROM,POS,REF,ALT) 序列完全一致，并按位对齐。 */
function align(father: ParsedVcf, mother: ParsedVcf, child: ParsedVcf): AlignedRow[] {
  const byMember = { father, mother, child } as const;
  const counts = MEMBERS.map((m) => byMember[m].variants.length);
  if (counts[0] !== counts[1] || counts[0] !== counts[2]) {
    throw badRequest(
      'TRIOS_RECORD_COUNT_MISMATCH',
      '三份 VCF 记录数不一致，必须具有完全相同的位点',
      { recordCounts: { father: counts[0], mother: counts[1], child: counts[2] } },
    );
  }

  const rows: AlignedRow[] = [];
  const n = counts[0];
  for (let i = 0; i < n; i++) {
    const f = father.variants[i];
    const m = mother.variants[i];
    const c = child.variants[i];
    const locus = { chrom: f.chrom, pos: f.pos, ref: f.ref, alt: f.alt };
    for (const [member, v] of [
      ['mother', m],
      ['child', c],
    ] as const) {
      if (
        v.chrom !== locus.chrom ||
        v.pos !== locus.pos ||
        v.ref !== locus.ref ||
        v.alt !== locus.alt
      ) {
        throw badRequest(
          'TRIOS_LOCI_MISMATCH',
          `三位成员第 ${i + 1} 条记录的 CHROM/POS/REF/ALT 不一致`,
          {
            recordIndex: i,
            father: { chrom: f.chrom, pos: f.pos, ref: f.ref, alt: f.alt },
            [member]: { chrom: v.chrom, pos: v.pos, ref: v.ref, alt: v.alt },
          },
        );
      }
    }
    rows.push({ locus, records: { father: f, mother: m, child: c } });
  }

  // 各文件内部已保证严格递增；对齐后全表必然同样严格递增，这里再防御性校验一次。
  for (let i = 1; i < rows.length; i++) {
    if (
      compareLoci(
        rows[i - 1].records.father,
        rows[i].records.father,
      ) >= 0
    ) {
      throw badRequest('LOCI_NOT_STRICTLY_INCREASING', '位点序列未严格递增');
    }
  }
  return rows;
}

/** 一种亲本单倍型分配方案：孩子 h1/h2 分别由 (亲本, 亲本单倍型) 解释。 */
interface Assignment {
  h1Parent: 'father' | 'mother';
  h1Hap: 0 | 1;
  h2Parent: 'father' | 'mother';
  h2Hap: 0 | 1;
}

const ALL_ASSIGNMENTS: readonly Assignment[] = (
  [
    { h1Parent: 'father', h2Parent: 'mother' },
    { h1Parent: 'mother', h2Parent: 'father' },
  ] as const
).flatMap((parents) =>
  ([0, 1] as const).flatMap((h1Hap) =>
    ([0, 1] as const).map((h2Hap) => ({
      h1Parent: parents.h1Parent,
      h1Hap,
      h2Parent: parents.h2Parent,
      h2Hap,
    })),
  ),
);

/** 某方案在某位点是否成立：孩子两条等位分别能取自指定亲本单倍型。 */
function assignmentMatches(row: AlignedRow, a: Assignment): boolean {
  const child = row.records.child.alleles;
  const p1 = row.records[a.h1Parent].alleles[a.h1Hap];
  const p2 = row.records[a.h2Parent].alleles[a.h2Hap];
  return child[0] === p1 && child[1] === p2;
}

const REASON_TEXT: Record<string, string> = {
  CHILD_ALLELE_IMPOSSIBLE:
    '子代等位无法由父母等位基因组合解释（违反孟德尔遗传）',
  HAPLOTYPE_SWITCH_WITHIN_SEGMENT:
    '区段内无法由父母各一条单倍型连续解释：亲本来源或所选亲本单倍型必须全程固定，却在本位点被迫切换',
};

interface FailureInfo {
  reasonCode: 'CHILD_ALLELE_IMPOSSIBLE' | 'HAPLOTYPE_SWITCH_WITHIN_SEGMENT';
  reason: string;
}

/**
 * 裁决单个区段。区段内要求：孩子两条单倍型分别由父亲、母亲各一条单倍型
 * 连续解释，且亲本来源与所选亲本单倍型均不得中途切换。
 * 返回首个失败位点与原因；成功时返回固定的唯一分配（存在并列时按确定性顺序选取）。
 */
function judgeSegment(rows: AlignedRow[], startIdx: number, endIdx: number) {
  let feasible = new Set<Assignment>(ALL_ASSIGNMENTS);

  for (let i = startIdx; i <= endIdx; i++) {
    const row = rows[i];
    const remaining = new Set<Assignment>();
    for (const a of feasible) {
      if (assignmentMatches(row, a)) remaining.add(a);
    }
    if (remaining.size > 0) {
      feasible = remaining;
      continue;
    }

    // 本位点使全部“自区段起点延续下来”的候选分配失效。
    // 若本位点本身就不存在任何可行分配（即便允许重新选择来源/单倍型），
    // 则属于遗传不可能；否则属于段内被迫切换亲本来源或单倍型。
    let failure: FailureInfo;
    if (!ALL_ASSIGNMENTS.some((a) => assignmentMatches(row, a))) {
      failure = {
        reasonCode: 'CHILD_ALLELE_IMPOSSIBLE',
        reason: REASON_TEXT.CHILD_ALLELE_IMPOSSIBLE,
      };
    } else {
      failure = {
        reasonCode: 'HAPLOTYPE_SWITCH_WITHIN_SEGMENT',
        reason: REASON_TEXT.HAPLOTYPE_SWITCH_WITHIN_SEGMENT,
      };
    }
    return { ok: false as const, failureIndex: i, failure };
  }

  // 成功：按 ALL_ASSIGNMENTS 的确定性顺序选择代表分配，保证结果稳定。
  const chosen = ALL_ASSIGNMENTS.find((a) => feasible.has(a))!;
  return { ok: true as const, assignment: chosen };
}

/** 对三份已上传 VCF 执行完整裁决。 */
export function auditTrios(
  fatherBuf: Buffer,
  motherBuf: Buffer,
  childBuf: Buffer,
): AuditResult {
  const father = parseVcf(fatherBuf, 'father');
  const mother = parseVcf(motherBuf, 'mother');
  const child = parseVcf(childBuf, 'child');
  const rows = align(father, mother, child);

  // 以“任意成员 PS 相对上一位点发生变化”切分区段。
  const boundaries: number[] = [0];
  for (let i = 1; i < rows.length; i++) {
    const changed = MEMBERS.some(
      (m) => rows[i].records[m].ps !== rows[i - 1].records[m].ps,
    );
    if (changed) boundaries.push(i);
  }

  const segments: AuditSegment[] = boundaries.map((startIdx, segNo) => {
    const endIdx = segNo + 1 < boundaries.length ? boundaries[segNo + 1] - 1 : rows.length - 1;
    const first = rows[startIdx];
    const last = rows[endIdx];
    const phaseSets = Object.fromEntries(
      MEMBERS.map((m) => [m, first.records[m].ps]),
    ) as Record<MemberKey, string>;

    const outcome = judgeSegment(rows, startIdx, endIdx);
    const base = {
      index: segNo + 1,
      startChrom: first.locus.chrom,
      startPos: first.locus.pos,
      endChrom: last.locus.chrom,
      endPos: last.locus.pos,
      variantCount: endIdx - startIdx + 1,
      phaseSets,
    };

    if (outcome.ok) {
      const a = outcome.assignment;
      const assignment = {
        childHaplotype1: { parent: a.h1Parent, haplotype: (a.h1Hap + 1) as 1 | 2 },
        childHaplotype2: { parent: a.h2Parent, haplotype: (a.h2Hap + 1) as 1 | 2 },
      };
      return { ...base, verdict: 'CONSISTENT' as const, assignment, firstFailure: null };
    }

    const failRow = rows[outcome.failureIndex];
    return {
      ...base,
      verdict: 'INCONSISTENT' as const,
      assignment: null,
      firstFailure: {
        chrom: failRow.locus.chrom,
        pos: failRow.locus.pos,
        ref: failRow.locus.ref,
        alt: failRow.locus.alt,
        reasonCode: outcome.failure.reasonCode,
        reason: outcome.failure.reason,
      },
    };
  });

  return { totalVariants: rows.length, segments };
}
