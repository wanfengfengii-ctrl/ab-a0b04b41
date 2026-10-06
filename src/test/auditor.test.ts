import { test } from "node:test";
import assert from "node:assert/strict";
import { auditTrio } from "../auditor";
import type { Allele, ParsedVcf, Variant } from "../parser";

/** Build aligned trio files from per-site rows. */
interface TrioRow {
  chrom?: string;
  pos: number;
  ref?: string;
  alt?: string;
  f: readonly number[];
  m: readonly number[];
  c: readonly number[];
  ps?: readonly [string, string, string] | readonly string[];
}

function trio(
  rows: readonly TrioRow[],
): { father: ParsedVcf; mother: ParsedVcf; child: ParsedVcf } {
  const make = (member: "father" | "mother" | "child", which: "f" | "m" | "c"): ParsedVcf => ({
    member,
    variants: rows.map((r, i) => ({
      chrom: r.chrom ?? "chr1",
      pos: r.pos,
      ref: r.ref ?? "A",
      alt: r.alt ?? "G",
      hap: r[which] as [Allele, Allele],
      ps: r.ps ? r.ps[which === "f" ? 0 : which === "m" ? 1 : 2]! : String(Math.floor(i / 10) + 1),
    })),
  });
  return { father: make("father", "f"), mother: make("mother", "m"), child: make("child", "c") };
}

test("simple Mendelian transmission in one phase set is consistent", () => {
  const t = trio([
    { pos: 1, f: [0, 1], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { pos: 2, f: [0, 1], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
  ]);
  const report = auditTrio(t.father, t.mother, t.child);
  assert.equal(report.segments.length, 1);
  assert.equal(report.segments[0]!.verdict, "consistent");
  assert.deepEqual(report.segments[0]!.assignment, {
    childHaplotype1: { parent: "father", parentalHaplotype: 2 },
    childHaplotype2: { parent: "mother", parentalHaplotype: 1 },
  });
});

test("impossible child genotype is a MENDEL_CONFLICT at that site", () => {
  const t = trio([
    { pos: 1, f: [0, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
  ]);
  const report = auditTrio(t.father, t.mother, t.child);
  assert.equal(report.segments[0]!.verdict, "inconsistent");
  assert.equal(report.segments[0]!.failure!.reasonCode, "MENDEL_CONFLICT");
  assert.equal(report.segments[0]!.failure!.index, 1);
});

test("per-site Mendelian match but haplotype switch mid-segment fails", () => {
  // Child hap1 always takes the paternal allele, but which paternal homolog
  // carries it flips between sites while father's PS stays constant.
  const t = trio([
    { pos: 1, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { pos: 2, f: [0, 1], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
  ]);
  const report = auditTrio(t.father, t.mother, t.child);
  assert.equal(report.segments.length, 1);
  assert.equal(report.segments[0]!.verdict, "inconsistent");
  assert.equal(report.segments[0]!.failure!.reasonCode, "HAPLOTYPE_SWITCH");
  assert.equal(report.segments[0]!.failure!.index, 2);
});

test("per-site Mendelian match but parent-of-origin switch mid-segment fails", () => {
  // Site 1: child hap1 = father's 1, hap2 = mother's 0.
  // Site 2: to stay allelically valid the same child hap order must now draw
  // hap1 from the mother (father lacks the alternate allele).
  const t = trio([
    { pos: 1, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { pos: 2, f: [0, 0], m: [1, 0], c: [1, 0], ps: ["1", "1", "1"] },
  ]);
  const report = auditTrio(t.father, t.mother, t.child);
  assert.equal(report.segments[0]!.verdict, "inconsistent");
  assert.equal(report.segments[0]!.failure!.reasonCode, "ORIGIN_SWITCH");
  assert.equal(report.segments[0]!.failure!.index, 2);
});

test("a PS change in any member opens a new independently judged segment", () => {
  const sameRows = [
    { pos: 1, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    // child PS change alone opens a new segment, so a flip here is allowed.
    { pos: 2, f: [0, 1], m: [0, 0], c: [1, 0], ps: ["1", "1", "2"] },
  ];
  const ok = auditTrio(...Object.values(trio(sameRows)) as [ParsedVcf, ParsedVcf, ParsedVcf]);
  assert.equal(ok.segments.length, 2);
  assert.ok(ok.segments.every((s) => s.verdict === "consistent"));

  // With no PS change, the identical data must fail as one segment.
  const flat = sameRows.map((r) => ({ ...r, ps: ["1", "1", "1"] as [string, string, string] }));
  const bad = auditTrio(...Object.values(trio(flat)) as [ParsedVcf, ParsedVcf, ParsedVcf]);
  assert.equal(bad.segments.length, 1);
  assert.equal(bad.segments[0]!.verdict, "inconsistent");
});

test("father PS change also segments; mother PS change also segments", () => {
  for (const memberPs of [0, 1] as const) {
    const ps1: [string, string, string] = ["1", "1", "1"];
    const ps2: [string, string, string] = ["2", "1", "1"];
    if (memberPs === 1) ps2[0] = "1", ps2[1] = "2";
    const rows = [
      { pos: 1, f: [1, 0], m: [0, 0], c: [1, 0], ps: ps1 },
      { pos: 2, f: [0, 1], m: [0, 0], c: [1, 0], ps: ps2 },
    ];
    const report = auditTrio(...Object.values(trio(rows)) as [ParsedVcf, ParsedVcf, ParsedVcf]);
    assert.equal(report.segments.length, 2, `member index ${memberPs}`);
  }
});

test("homozygous sites allow multiple explanations and do not force a switch", () => {
  // Child 1|1: father and mother each contribute 1. Intervening informative
  // sites fix the assignment; homozygous ambiguity must not break continuity.
  const t = trio([
    { pos: 1, f: [1, 0], m: [0, 1], c: [1, 1], ps: ["1", "1", "1"] },
    { pos: 2, f: [1, 1], m: [1, 1], c: [1, 1], ps: ["1", "1", "1"] },
    { pos: 3, f: [1, 0], m: [0, 1], c: [1, 1], ps: ["1", "1", "1"] },
  ]);
  const report = auditTrio(t.father, t.mother, t.child);
  assert.equal(report.segments[0]!.verdict, "consistent");
});

test("first failing site is reported even when later sites recover", () => {
  const t = trio([
    { pos: 1, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { pos: 2, f: [0, 0], m: [1, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { pos: 3, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
  ]);
  const seg = auditTrio(t.father, t.mother, t.child).segments[0]!;
  assert.equal(seg.verdict, "inconsistent");
  assert.equal(seg.failure!.site.pos, 2);
  assert.equal(seg.end.pos, 2);
});

test("segment ranges use 1-based record indices across chromosome gaps", () => {
  const rows = [
    { chrom: "chr1", pos: 10, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["1", "1", "1"] },
    { chrom: "chr1", pos: 20, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["2", "2", "2"] },
    { chrom: "chr2", pos: 5, f: [1, 0], m: [0, 0], c: [1, 0], ps: ["2", "2", "2"] },
  ];
  const report = auditTrio(...Object.values(trio(rows)) as [ParsedVcf, ParsedVcf, ParsedVcf]);
  assert.equal(report.segments[0]!.startIndex, 1);
  assert.equal(report.segments[0]!.endIndex, 1);
  assert.equal(report.segments[1]!.startIndex, 2);
  assert.equal(report.segments[1]!.endIndex, 3);
});
