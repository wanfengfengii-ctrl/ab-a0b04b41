import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * End-to-end smoke test against the real HTTP server entry point.
 * Exits 0 on full success, 1 on the first failed expectation.
 */

const PORT = Number(process.env.SMOKE_PORT ?? 8099);
// When BASE_URL is provided (e.g. the one-shot docker "verify" service hitting
// the "api" service over the compose network) no child server is spawned.
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

const HEADER = [
  "##fileformat=VCFv4.2",
  "##FORMAT=<ID=GT,Number=1,Type=String,Description=\"Genotype\">",
  "##FORMAT=<ID=PS,Number=1,Type=Integer,Description=\"Phase set\">",
  "#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1",
].join("\n");

function vcf(rows: Array<[number, string, string, string]>): string {
  // rows: [pos, gt, ps, alt]
  const body = rows
    .map(([pos, gt, ps, alt]) => `chr1\t${pos}\t.\tA\t${alt}\t.\t.\t.\tGT:PS\t${gt}:${ps}`)
    .join("\n");
  return `${HEADER}\n${body}\n`;
}

let failures = 0;

function check(condition: boolean, label: string, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
    if (detail !== undefined) console.error(`    ${JSON.stringify(detail)}`);
  }
}

async function waitForHealth(child: ChildProcess | null, timeoutMs = 20000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child !== null && child.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function postAudit(files: {
  father?: string | Buffer;
  mother?: string | Buffer;
  child?: string | Buffer;
}): Promise<{ status: number; body: any }> {
  const form = new FormData();
  for (const name of ["father", "mother", "child"] as const) {
    const content = files[name];
    if (content !== undefined) {
      const blobPart: BlobPart =
        typeof content === "string" ? content : new Uint8Array(content);
      form.set(name, new Blob([blobPart]), `${name}.vcf`);
    }
  }
  const res = await fetch(`${BASE}/api/trios/audit`, { method: "POST", body: form });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const external = process.env.BASE_URL !== undefined;
  const child = external
    ? null
    : spawn(process.execPath, [path.join(__dirname, "server.js")], {
        env: { ...process.env, PORT: String(PORT) },
        stdio: ["ignore", "pipe", "pipe"],
      });
  if (child) {
    child.stdout?.on("data", (d) => process.stdout.write(`[server] ${d}`));
    child.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));
  }

  try {
    console.log(`smoke: waiting for API health at ${BASE}/health`);
    const healthy = await waitForHealth(child);
    check(healthy, external ? "api service responds to /health" : "GET /health responds before timeout");
    if (!healthy) return;

    console.log("smoke: consistent trio");
    const good = await postAudit({
      father: vcf([
        [100, "1|0", "100", "G"],
        [200, "1|0", "100", "T"],
      ]),
      mother: vcf([
        [100, "0|0", "100", "G"],
        [200, "0|1", "100", "T"],
      ]),
      child: vcf([
        [100, "1|0", "100", "G"],
        [200, "1|1", "100", "T"],
      ]),
    });
    check(good.status === 200, "consistent trio returns 200", good);
    check(good.body?.segmentCount === 1, "one adjudicated segment", good.body);
    check(
      good.body?.segments?.[0]?.verdict === "consistent" &&
        good.body?.segments?.[0]?.range?.start?.pos === 100 &&
        good.body?.segments?.[0]?.range?.end?.pos === 200,
      "segment range and verdict correct",
      good.body,
    );

    console.log("smoke: per-site Mendelian but haplotype discontinuity");
    const switchy = await postAudit({
      father: vcf([
        [100, "1|0", "100", "G"],
        [200, "0|1", "100", "G"],
      ]),
      mother: vcf([
        [100, "0|0", "100", "G"],
        [200, "0|0", "100", "G"],
      ]),
      child: vcf([
        [100, "1|0", "100", "G"],
        [200, "1|0", "100", "G"],
      ]),
    });
    check(switchy.status === 200, "audit still returns 200", switchy);
    check(
      switchy.body?.segments?.[0]?.verdict === "inconsistent" &&
        switchy.body?.segments?.[0]?.failure?.reasonCode === "HAPLOTYPE_SWITCH" &&
        switchy.body?.segments?.[0]?.failure?.site?.pos === 200,
      "first failing site 200 flagged HAPLOTYPE_SWITCH",
      switchy.body,
    );

    console.log("smoke: structural misalignment is rejected wholesale");
    const misaligned = await postAudit({
      father: vcf([[100, "0|0", "100", "G"]]),
      mother: vcf([[100, "0|0", "100", "G"]]),
      child: vcf([[101, "0|0", "100", "G"]]),
    });
    check(misaligned.status === 400, "misaligned trio returns 400", misaligned);
    check(misaligned.body?.error?.code === "SITES_NOT_ALIGNED", "stable code SITES_NOT_ALIGNED", misaligned.body);

    console.log("smoke: missing multipart field is rejected");
    const missing = await postAudit({
      father: vcf([[100, "0|0", "100", "G"]]),
      mother: vcf([[100, "0|0", "100", "G"]]),
    });
    check(missing.status === 400 && missing.body?.error?.code === "MISSING_FILE", "MISSING_FILE 400", missing.body);
  } finally {
    child?.kill("SIGTERM");
  }
}

main()
  .then(() => {
    if (failures > 0) {
      console.error(`smoke: ${failures} check(s) failed`);
      process.exit(1);
    }
    console.log("smoke: all checks passed");
    process.exit(0);
  })
  .catch((err) => {
    console.error("smoke: fatal error", err);
    process.exit(1);
  });
