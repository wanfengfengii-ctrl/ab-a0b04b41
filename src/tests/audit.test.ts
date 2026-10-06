import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { auditTrios } from '../audit.js';
import { parseVcf } from '../parser.js';
import { ApiError } from '../errors.js';
import { buildVcf, snpRows, type GenotypeRow } from './helpers.js';

/**
 * 标准位点布局（chr1，POS 100 起）：
 *  father 0|1 / 0|1 / 1|0
 *  mother 0|0 / 1|0 / 0|1
 * 孩子 h1←父亲 hap1（0,0,1）、h2←母亲 hap1（0,1,0）时全程一致：
 *  child  0|0 / 0|1 / 1|0
 */
const FATHER: GenotypeRow[] = [
  ['chr1', 100, 'A', 'T', '0|1', '1'],
  ['chr1', 101, 'A', 'T', '0|1', '1'],
  ['chr1', 102, 'A', 'T', '1|0', '1'],
];
const MOTHER: GenotypeRow[] = [
  ['chr1', 100, 'A', 'T', '0|0', '1'],
  ['chr1', 101, 'A', 'T', '1|0', '1'],
  ['chr1', 102, 'A', 'T', '0|1', '1'],
];
const CHILD_OK: GenotypeRow[] = [
  ['chr1', 100, 'A', 'T', '0|0', '1'],
  ['chr1', 101, 'A', 'T', '0|1', '1'],
  ['chr1', 102, 'A', 'T', '1|0', '1'],
];

function trio(child: GenotypeRow[], father = FATHER, mother = MOTHER) {
  return auditTrios(
    buildVcf('dad', father),
    buildVcf('mom', mother),
    buildVcf('kid', child),
  );
}

describe('auditTrios 单倍型连续传递裁决', () => {
  it('全程定相一致：单区段 CONSISTENT 并给出固定亲本分配', () => {
    const result = trio(CHILD_OK);
    assert.equal(result.totalVariants, 3);
    assert.equal(result.segments.length, 1);
    const seg = result.segments[0];
    assert.equal(seg.verdict, 'CONSISTENT');
    assert.equal(seg.startPos, 100);
    assert.equal(seg.endPos, 102);
    assert.equal(seg.variantCount, 3);
    assert.deepEqual(seg.phaseSets, { father: '1', mother: '1', child: '1' });
    assert.deepEqual(seg.assignment, {
      childHaplotype1: { parent: 'father', haplotype: 1 },
      childHaplotype2: { parent: 'mother', haplotype: 1 },
    });
    assert.equal(seg.firstFailure, null);
  });

  it('孩子 PS 变化开启新区段，两段可采用不同的亲本来源分配', () => {
    // 位点 3（POS 102）孩子进入 PS=2：h1←母亲 hap2(=1)、h2←父亲 hap2(=0) → 1|0
    // 与 CHILD_OK 的 1|0 相同但来源翻转；由于相位集断开，两段都应一致。
    const child: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|1', '1'],
      ['chr1', 102, 'A', 'T', '1|0', '2'],
    ];
    const result = trio(child);
    assert.equal(result.segments.length, 2);
    assert.deepEqual(
      [result.segments[0].startPos, result.segments[0].endPos],
      [100, 101],
    );
    assert.deepEqual(
      [result.segments[1].startPos, result.segments[1].endPos],
      [102, 102],
    );
    assert.equal(result.segments[0].phaseSets.child, '1');
    assert.equal(result.segments[1].phaseSets.child, '2');
    for (const seg of result.segments) assert.equal(seg.verdict, 'CONSISTENT');
    // 第二区段：孩子 1|0，h1←父亲 hap1(=1)，h2←母亲 hap1(=1)
    assert.deepEqual(result.segments[1].assignment, {
      childHaplotype1: { parent: 'father', haplotype: 1 },
      childHaplotype2: { parent: 'mother', haplotype: 1 },
    });
  });

  it('父亲 PS 变化同样开启新区段', () => {
    const father: GenotypeRow[] = FATHER.map((r) => [...r]);
    father[2] = ['chr1', 102, 'A', 'T', '1|0', '9'];
    const result = trio(CHILD_OK, father);
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[1].phaseSets.father, '9');
  });

  it('段内必须切换亲本单倍型：HAPLOTYPE_SWITCH_WITHIN_SEGMENT 指向首个失败位点', () => {
    // 前两点固定 F0M0；第三点孩子为 0|1，需改为 F1M1 才能解释（等位本身均可由父母提供）。
    const child: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|1', '1'],
      ['chr1', 102, 'A', 'T', '0|1', '1'],
    ];
    const result = trio(child);
    assert.equal(result.segments.length, 1);
    const seg = result.segments[0];
    assert.equal(seg.verdict, 'INCONSISTENT');
    assert.equal(seg.assignment, null);
    assert.deepEqual(seg.firstFailure, {
      chrom: 'chr1',
      pos: 102,
      ref: 'A',
      alt: 'T',
      reasonCode: 'HAPLOTYPE_SWITCH_WITHIN_SEGMENT',
      reason: seg.firstFailure!.reason,
    });
    assert.match(seg.firstFailure!.reason, /单倍型/);
  });

  it('孩子出现父母均无的等位：CHILD_ALLELE_IMPOSSIBLE', () => {
    const father: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|1', '1'],
      ['chr1', 101, 'A', 'T', '0|0', '1'],
    ];
    const mother: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|0', '1'],
    ];
    const child: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|1', '1'],
    ];
    const result = trio(child, father, mother);
    assert.equal(result.segments[0].verdict, 'INCONSISTENT');
    assert.equal(result.segments[0].firstFailure?.pos, 101);
    assert.equal(result.segments[0].firstFailure?.reasonCode, 'CHILD_ALLELE_IMPOSSIBLE');
  });

  it('PS 不变时区段可跨染色体，范围分别给出起止染色体', () => {
    const father: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|1', '1'],
      ['chr2', 100, 'A', 'T', '0|1', '1'],
    ];
    const mother: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr2', 100, 'A', 'T', '0|0', '1'],
    ];
    const child: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr2', 100, 'A', 'T', '0|0', '1'],
    ];
    const result = trio(child, father, mother);
    assert.equal(result.segments.length, 1);
    const seg = result.segments[0];
    assert.equal(seg.verdict, 'CONSISTENT');
    assert.equal(seg.startChrom, 'chr1');
    assert.equal(seg.endChrom, 'chr2');
    assert.equal(seg.variantCount, 2);
  });

  it('孩子等位虽在父母并集中出现、但一方无法贡献所需等位：CHILD_ALLELE_IMPOSSIBLE', () => {
    // 父亲 1|1、母亲 0|0；孩子 1|1 要求两条等位均来自父亲，母亲无 1 可传 → 遗传不可能
    const father: GenotypeRow[] = [['chr1', 100, 'A', 'T', '1|1', '1']];
    const mother: GenotypeRow[] = [['chr1', 100, 'A', 'T', '0|0', '1']];
    const child: GenotypeRow[] = [['chr1', 100, 'A', 'T', '1|1', '1']];
    const result = trio(child, father, mother);
    assert.equal(result.segments[0].verdict, 'INCONSISTENT');
    assert.equal(result.segments[0].firstFailure?.reasonCode, 'CHILD_ALLELE_IMPOSSIBLE');
  });

  it('前一区段一致、新区段（母亲 PS 变化）遗传不可能：两段分别裁决', () => {
    const mother: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|0', '7'],
      ['chr1', 102, 'A', 'T', '0|1', '7'],
    ];
    const father: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|1', '1'],
      ['chr1', 101, 'A', 'T', '0|0', '1'],
      ['chr1', 102, 'A', 'T', '1|0', '1'],
    ];
    const child: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|1', '1'],
      ['chr1', 102, 'A', 'T', '1|0', '1'],
    ];
    const result = trio(child, father, mother);
    assert.equal(result.segments.length, 2);
    assert.equal(result.segments[0].verdict, 'CONSISTENT');
    assert.equal(result.segments[1].verdict, 'INCONSISTENT');
    assert.equal(result.segments[1].firstFailure?.pos, 101);
    assert.equal(result.segments[1].firstFailure?.reasonCode, 'CHILD_ALLELE_IMPOSSIBLE');
  });
});

describe('parseVcf 严格校验', () => {
  const ok = () => buildVcf('s', snpRows(3, () => '0|1'));

  function expectCode(fn: () => unknown, code: string) {
    assert.throws(
      fn,
      (err: unknown) => err instanceof ApiError && err.code === code,
      `应抛出 ${code}`,
    );
  }

  it('拒绝未相位或不完整基因型', () => {
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T', '0/1', '1']]), 'child'), 'UNPHASED_OR_INCOMPLETE_GENOTYPE');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T', './.', '1']]), 'child'), 'UNPHASED_OR_INCOMPLETE_GENOTYPE');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T', '1', '1']]), 'child'), 'UNPHASED_OR_INCOMPLETE_GENOTYPE');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T', '0|2', '1']]), 'child'), 'UNPHASED_OR_INCOMPLETE_GENOTYPE');
  });

  it('拒绝 FORMAT 偏离 GT:PS 与 PS 非法', () => {
    expectCode(() => parseVcf(buildVcf('s', snpRows(1, () => '0|1'), { format: 'GT' }), 'father'), 'UNEXPECTED_FORMAT');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T', '0|1', 'x']]), 'father'), 'MALFORMED_PHASE_SET');
  });

  it('拒绝非 SNP / 非双等位', () => {
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'AT', 'A', '0|1', '1']]), 'father'), 'NOT_SNP');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'A', '0|1', '1']]), 'father'), 'NOT_SNP');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', 'T,C', '0|1', '1']]), 'father'), 'NOT_BIALLELIC');
    expectCode(() => parseVcf(buildVcf('s', [['chr1', 1, 'A', '<DEL>', '0|1', '1']]), 'father'), 'NOT_BIALLELIC');
  });

  it('拒绝位点非严格递增', () => {
    const rows: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|1', '1'],
      ['chr1', 100, 'A', 'T', '0|0', '1'],
    ];
    expectCode(() => parseVcf(buildVcf('s', rows), 'father'), 'LOCI_NOT_STRICTLY_INCREASING');
  });

  it('记录数必须在 1..2000', () => {
    expectCode(() => parseVcf(buildVcf('s', []), 'father'), 'EMPTY_VCF');
    expectCode(() => parseVcf(buildVcf('s', snpRows(2001, () => '0|1')), 'father'), 'TOO_MANY_RECORDS');
  });

  it('恰好一个样本、VCF 4.2 头', () => {
    expectCode(
      () => parseVcf(buildVcf('s', snpRows(1, () => '0|1'), { extraSample: 's2' }), 'father'),
      'MALFORMED_HEADER',
    );
    expectCode(
      () => parseVcf(buildVcf('s', snpRows(1, () => '0|1'), { fileformat: '##fileformat=VCFv4.1' }), 'father'),
      'UNSUPPORTED_VCF_VERSION',
    );
  });

  it('接受 PS 在文件中途变化（同一文件内允许多个相位集）', () => {
    const parsed = parseVcf(
      buildVcf('s', [
        ['chr1', 1, 'A', 'T', '0|1', '5'],
        ['chr1', 2, 'A', 'T', '1|0', '5'],
        ['chr1', 3, 'A', 'C', '0|0', '6'],
      ]),
      'child',
    );
    assert.equal(parsed.variants[2].ps, '6');
    assert.equal(parsed.sample, 's');
  });

  it('合法文件解析出等位与相位', () => {
    const parsed = parseVcf(ok(), 'father');
    assert.deepEqual([...parsed.variants[0].alleles], [0, 1]);
    assert.deepEqual([...parsed.variants[2].alleles], [0, 1]);
  });

  it('拒绝非法 UTF-8 字节序列', () => {
    const bad = Buffer.concat([Buffer.from('##fileformat=VCFv4.2\n', 'utf8'), Buffer.from([0xff, 0xfe, 0x80])]);
    expectCode(() => parseVcf(bad, 'father'), 'INVALID_UTF8');
  });
});

describe('三人组位点对齐', () => {
  function expectCode(fn: () => unknown, code: string) {
    assert.throws(
      fn,
      (err: unknown) => err instanceof ApiError && err.code === code,
      `应抛出 ${code}`,
    );
  }

  it('记录数不同整体拒绝', () => {
    expectCode(
      () =>
        auditTrios(
          buildVcf('d', snpRows(3, () => '0|1')),
          buildVcf('m', snpRows(2, () => '0|1')),
          buildVcf('c', snpRows(3, () => '0|1')),
        ),
      'TRIOS_RECORD_COUNT_MISMATCH',
    );
  });

  it('同位点序号 POS 不一致整体拒绝', () => {
    // 末位 POS 取更小值会同时破坏该文件内严格递增，故改用两条记录的安全位移：
    // 母亲位点序列在第二处分叉且各自仍严格递增。
    const dad = snpRows(2, () => '0|1');
    const mom: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|1', '1'],
      ['chr1', 500, 'A', 'T', '0|1', '1'],
    ];
    const kid = snpRows(2, () => '0|1');
    expectCode(
      () =>
        auditTrios(
          buildVcf('d', dad),
          buildVcf('m', mom),
          buildVcf('c', kid),
        ),
      'TRIOS_LOCI_MISMATCH',
    );
  });

  it('ALT 不一致整体拒绝', () => {
    const c = snpRows(3, () => '0|1');
    c[0] = ['chr1', 100, 'A', 'G', '0|1', '1'];
    expectCode(
      () =>
        auditTrios(
          buildVcf('d', snpRows(3, () => '0|1')),
          buildVcf('m', snpRows(3, () => '0|1')),
          buildVcf('c', c),
        ),
      'TRIOS_LOCI_MISMATCH',
    );
  });
});
