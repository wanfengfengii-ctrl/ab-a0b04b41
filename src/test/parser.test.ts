import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVcf } from "../parser";
import { AuditError } from "../errors";

function isCode(e: unknown, code: string): boolean {
  return e instanceof AuditError && e.code === code;
}

const HEADER = [
  "##fileformat=VCFv4.2",
  "##INFO=<ID=NS,Number=1,Type=Integer,Description=\"Samples\">",
  "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">",
  "##FORMAT=<ID=PS,Number=1,Type=Integer,Description=\"Phase set\">",
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1",
].join("\n");

function vcf(rows: Array<[string, number, string, string, string, string]>): string {
  const body = rows
    .map(([chrom, pos, ref, alt, gt, ps]) => `${chrom}\t${pos}\t.\t${ref}\t${alt}\t.\t.\t.\tGT:PS\t${gt}:${ps}`)
    .join("\n");
  return `${HEADER}\n${body}\n`;
}

test("accepts a well-formed phased VCF", () => {
  const text = vcf([
    ["chr1", 100, "A", "G", "0|1", "100"],
    ["chr1", 200, "C", "T", "1|1", "100"],
  ]);
  const parsed = parseVcf(text, "father");
  assert.equal(parsed.variants.length, 2);
  assert.deepEqual(parsed.variants[0]!.hap, [0, 1]);
  assert.equal(parsed.variants[1]!.ps, "100");
});

test("rejects missing fileformat or wrong version", () => {
  const text = vcf([["chr1", 1, "A", "G", "0|0", "1"]]).replace("##fileformat=VCFv4.2", "##fileformat=VCFv4.1");
  assert.throws(() => parseVcf(text, "father"), (e: unknown) => isCode(e, "UNSUPPORTED_VCF_VERSION"));
});

test("rejects unphased or incomplete genotypes", () => {
  for (const bad of ["0/1", "0|.", ".|1", "1|2", "0"]) {
    const text = vcf([["chr1", 1, "A", "G", bad, "1"]]);
    assert.throws(
      () => parseVcf(text, "child"),
      (e: unknown) => isCode(e, "INVALID_GENOTYPE"),
      `should reject GT=${bad}`,
    );
  }
});

test("rejects non-SNP, multiallelic and indel records", () => {
  const cases: Array<[string, string]> = [
    ["AC", "G"],
    ["A", "G,T"],
    ["A", "."],
    ["AT", "A"],
  ];
  for (const [ref, alt] of cases) {
    const text = vcf([["chr1", 1, ref, alt, "0|1", "1"]]);
    assert.throws(
      () => parseVcf(text, "mother"),
      (e: unknown) => isCode(e, "UNSUPPORTED_VARIANT"),
      `should reject REF=${ref} ALT=${alt}`,
    );
  }
});

test("rejects wrong FORMAT or missing PS", () => {
  let text = HEADER + "\nchr1\t1\t.\tA\tG\t.\t.\t.\tGT\t0|1\n";
  assert.throws(() => parseVcf(text, "father"), (e: unknown) => isCode(e, "UNSUPPORTED_FORMAT"));

  text = vcf([["chr1", 1, "A", "G", "0|1", "."]]);
  assert.throws(() => parseVcf(text, "father"), (e: unknown) => isCode(e, "INVALID_PHASE_SET"));
});

test("rejects zero or multiple samples", () => {
  const noSample = HEADER.replace("\tS1", "");
  assert.throws(
    () => parseVcf(noSample + "\nchr1\t1\t.\tA\tG\t.\t.\t.\tGT:PS\t0|1:1\n", "father"),
    (e: unknown) => isCode(e, "SAMPLE_COUNT_MISMATCH"),
  );
  const twoSamples = HEADER.replace("\tS1", "\tS1\tS2");
  assert.throws(
    () => parseVcf(twoSamples + "\nchr1\t1\t.\tA\tG\t.\t.\t.\tGT:PS\t0|1:1\t1|0:1\n", "father"),
    (e: unknown) => isCode(e, "SAMPLE_COUNT_MISMATCH"),
  );
});

test("rejects non-strictly-increasing coordinates", () => {
  const dup = vcf([
    ["chr1", 100, "A", "G", "0|0", "1"],
    ["chr1", 100, "A", "G", "0|0", "1"],
  ]);
  assert.throws(() => parseVcf(dup, "father"), (e: unknown) => e instanceof AuditError);

  const outOfOrder = vcf([
    ["chr1", 200, "A", "G", "0|0", "1"],
    ["chr1", 100, "A", "G", "0|0", "1"],
  ]);
  assert.throws(() => parseVcf(outOfOrder, "father"), (e: unknown) => e instanceof AuditError);
});

test("accepts strict REF/ALT tie-breakers at the same coordinate", () => {
  const text = vcf([
    ["chr1", 100, "A", "C", "0|0", "1"],
    ["chr1", 100, "A", "G", "0|0", "1"],
    ["chr1", 100, "C", "A", "0|0", "1"],
  ]);
  assert.equal(parseVcf(text, "father").variants.length, 3);
});

test("rejects an empty VCF", () => {
  assert.throws(() => parseVcf(HEADER + "\n", "father"), (e: unknown) => isCode(e, "EMPTY_VCF"));
});

test("rejects non-UTF8 input", () => {
  const bytes = Buffer.concat([
    Buffer.from(HEADER + "\nchr1\t1\t.\tA\tG\t.\t.\t.\tGT:PS\t0|1:1\n", "utf8"),
    Buffer.from([0xff, 0xfe]),
  ]);
  // The parser itself sees a string; the fatal decoder lives in the app layer,
  // but the parser also guards against U+FFFD replacement characters.
  const text = new TextDecoder("utf-8").decode(bytes);
  assert.throws(() => parseVcf(text, "father"), (e: unknown) => e instanceof AuditError);
});
