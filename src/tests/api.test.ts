import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { MAX_FILE_SIZE } from '../multipart.js';
import { buildVcf, encodeMultipart, snpRows, type GenotypeRow } from './helpers.js';

let server: Server;
let base: string;

before(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

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

function trioBody(child: GenotypeRow[], boundary = 'trio-test-boundary') {
  return {
    boundary,
    body: encodeMultipart(
      [
        { name: 'father', filename: 'father.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'mother.vcf', content: buildVcf('mom', MOTHER) },
        { name: 'child', filename: 'child.vcf', content: buildVcf('kid', child) },
      ],
      boundary,
    ),
  };
}

async function postAudit(body: Buffer, boundary: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/trios/audit`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...headers },
    body: new Uint8Array(body),
  });
  return { status: res.status, json: (await res.json()) as any };
}

describe('POST /api/trios/audit', () => {
  it('健康检查可访问', async () => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.status, 'ok');
  });

  it('一致三人组：200，按区段返回范围与裁决', async () => {
    const { boundary, body } = trioBody(CHILD_OK);
    const { status, json } = await postAudit(body, boundary);
    assert.equal(status, 200);
    assert.equal(json.status, 'ok');
    assert.equal(json.totalVariants, 3);
    assert.equal(json.segments.length, 1);
    assert.deepEqual(json.segments[0].assignment, {
      childHaplotype1: { parent: 'father', haplotype: 1 },
      childHaplotype2: { parent: 'mother', haplotype: 1 },
    });
  });

  it('遗传/相位不一致仍 200，区段级 INCONSISTENT 含首个失败位点与原因码', async () => {
    const childBad: GenotypeRow[] = [
      ['chr1', 100, 'A', 'T', '0|0', '1'],
      ['chr1', 101, 'A', 'T', '0|1', '1'],
      ['chr1', 102, 'A', 'T', '0|1', '1'],
    ];
    const { boundary, body } = trioBody(childBad);
    const { status, json } = await postAudit(body, boundary);
    assert.equal(status, 200);
    assert.equal(json.segments[0].verdict, 'INCONSISTENT');
    assert.equal(json.segments[0].firstFailure.pos, 102);
    assert.equal(json.segments[0].firstFailure.reasonCode, 'HAPLOTYPE_SWITCH_WITHIN_SEGMENT');
  });

  it('文件结构非法整体拒绝（400 + 稳定原因码）', async () => {
    const bad = Buffer.from('not a vcf\n');    const body = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', MOTHER) },
        { name: 'child', filename: 'c.vcf', content: bad },
      ],
      'trio-test-boundary',
    );
    const { status, json } = await postAudit(body, 'trio-test-boundary');
    assert.equal(status, 400);
    assert.equal(json.error.code, 'MALFORMED_VCF');
  });

  it('三方位点不对齐整体拒绝（400 TRIOS_LOCI_MISMATCH）', async () => {
    const motherShifted: GenotypeRow[] = MOTHER.map((r) => [...r]);
    // 不改动位置（避免破坏文件内严格递增），仅令该位点 ALT 与其他成员不同
    motherShifted[0] = ['chr1', 100, 'A', 'G', '0|0', '1'];
    const body = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', motherShifted) },
        { name: 'child', filename: 'c.vcf', content: buildVcf('kid', CHILD_OK) },
      ],
      'trio-test-boundary',
    );
    const { status, json } = await postAudit(body, 'trio-test-boundary');
    assert.equal(status, 400);
    assert.equal(json.error.code, 'TRIOS_LOCI_MISMATCH');
  });

  it('缺少文件字段 → 400 MISSING_FILE', async () => {
    const body = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', MOTHER) },
      ],
      'trio-test-boundary',
    );
    const { status, json } = await postAudit(body, 'trio-test-boundary');
    assert.equal(status, 400);
    assert.equal(json.error.code, 'MISSING_FILE');
  });

  it('单文件超过 2 MiB → 413 FILE_TOO_LARGE', async () => {
    const huge = buildVcf('kid', snpRows(1, () => '0|1'));
    huge[0] = 0x23; // 保持文本形态，大小超限即可
    const padded = Buffer.concat([huge, Buffer.alloc(MAX_FILE_SIZE + 10, 0x41)]);
    const body = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', MOTHER) },
        { name: 'child', filename: 'c.vcf', content: padded },
      ],
      'trio-test-boundary',
    );
    const { status, json } = await postAudit(body, 'trio-test-boundary');
    assert.equal(status, 413);
    assert.equal(json.error.code, 'FILE_TOO_LARGE');
  });

  it('错误 Content-Type → 415', async () => {
    const res = await fetch(`${base}/api/trios/audit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 415);
  });

  it('错误方法 → 405，未知路径 → 404', async () => {
    const res = await fetch(`${base}/api/trios/audit`, { method: 'GET' });
    assert.equal(res.status, 405);
    const res2 = await fetch(`${base}/nope`, { method: 'GET' });
    assert.equal(res2.status, 404);
  });

  it('重复字段 → 400 DUPLICATE_FIELD，未知字段 → 400 UNEXPECTED_FIELD', async () => {
    const dup = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'father', filename: 'f2.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', MOTHER) },
        { name: 'child', filename: 'c.vcf', content: buildVcf('kid', CHILD_OK) },
      ],
      'trio-test-boundary',
    );
    const r1 = await postAudit(dup, 'trio-test-boundary');
    assert.equal(r1.status, 400);
    assert.equal(r1.json.error.code, 'DUPLICATE_FIELD');

    const extra = encodeMultipart(
      [
        { name: 'father', filename: 'f.vcf', content: buildVcf('dad', FATHER) },
        { name: 'mother', filename: 'm.vcf', content: buildVcf('mom', MOTHER) },
        { name: 'child', filename: 'c.vcf', content: buildVcf('kid', CHILD_OK) },
        { name: 'sibling', filename: 's.vcf', content: buildVcf('kid', CHILD_OK) },
      ],
      'trio-test-boundary',
    );
    const r2 = await postAudit(extra, 'trio-test-boundary');
    assert.equal(r2.status, 400);
    assert.equal(r2.json.error.code, 'UNEXPECTED_FIELD');
  });
});
