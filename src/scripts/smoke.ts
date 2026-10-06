/**
 * 三人组 API 冒烟测试：自行启动服务 → 健康检查 → 上传三组 VCF
 * （一致 / 段内单倍型切换 / 文件结构非法）→ 关闭服务并以退出码汇总。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildVcf, type GenotypeRow } from '../tests/helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'server.js');
const PORT = Number(process.env.SMOKE_PORT ?? 18080);
// 设置 SMOKE_BASE_URL 时直接对已运行的服务冒烟（容器编排场景）；否则自行拉起临时实例。
const EXTERNAL_BASE = process.env.SMOKE_BASE_URL;
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;

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
const CHILD_SWITCH: GenotypeRow[] = [
  ['chr1', 100, 'A', 'T', '0|0', '1'],
  ['chr1', 101, 'A', 'T', '0|1', '1'],
  ['chr1', 102, 'A', 'T', '0|1', '1'],
];

let failures = 0;

function check(name: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${name}`, detail ?? '');
  }
}

async function waitForHealthy(proc: ChildProcess, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) return false;
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // 服务尚未就绪
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function postTrio(child: Buffer): Promise<{ status: number; json: any }> {
  const fd = new FormData();
  fd.append('father', new Blob([new Uint8Array(buildVcf('dad', FATHER))]), 'father.vcf');
  fd.append('mother', new Blob([new Uint8Array(buildVcf('mom', MOTHER))]), 'mother.vcf');
  fd.append('child', new Blob([new Uint8Array(child)]), 'child.vcf');
  const res = await fetch(`${BASE}/api/trios/audit`, { method: 'POST', body: fd });
  return { status: res.status, json: await res.json() };
}

async function main(): Promise<void> {
  let proc: ChildProcess | null = null;

  if (EXTERNAL_BASE) {
    console.log(`冒烟：针对外部服务 ${EXTERNAL_BASE}`);
  } else {
    console.log('冒烟：启动本地临时 API 服务');
    proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
    proc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  try {
    if (proc) {
      const healthy = await waitForHealthy(proc);
      check('GET /health 返回 200', healthy);
      if (!healthy) throw new Error('服务未在超时内就绪');
    } else {
      const res = await fetch(`${BASE}/health`).catch(() => null);
      check('GET /health 返回 200', res?.ok === true, res?.status);
    }

    console.log('冒烟：一致三人组');
    const ok = await postTrio(buildVcf('kid', CHILD_OK));
    check('一致请求返回 200', ok.status === 200, ok.status);
    check(
      '区段裁决 CONSISTENT 且含亲本分配',
      ok.json?.segments?.[0]?.verdict === 'CONSISTENT' &&
        ok.json.segments[0].assignment.childHaplotype1.parent === 'father' &&
        ok.json.segments[0].assignment.childHaplotype2.parent === 'mother',
      ok.json,
    );
    check('区段范围 100..102 / 3 条变异', ok.json?.totalVariants === 3, ok.json);

    console.log('冒烟：段内单倍型被迫切换');
    const bad = await postTrio(buildVcf('kid', CHILD_SWITCH));
    check('不一致仍返回 200（业务裁决结果）', bad.status === 200, bad.status);
    const seg = bad.json?.segments?.[0];
    check(
      '裁决 INCONSISTENT，首个失败位点 POS=102，原因码 HAPLOTYPE_SWITCH_WITHIN_SEGMENT',
      seg?.verdict === 'INCONSISTENT' &&
        seg.firstFailure?.pos === 102 &&
        seg.firstFailure?.reasonCode === 'HAPLOTYPE_SWITCH_WITHIN_SEGMENT',
      seg,
    );

    console.log('冒烟：文件结构非法整体拒绝');
    const fd = new FormData();
    fd.append('father', new Blob([new Uint8Array(buildVcf('dad', FATHER))]), 'father.vcf');
    fd.append('mother', new Blob([new Uint8Array(buildVcf('mom', MOTHER))]), 'mother.vcf');
    fd.append('child', new Blob([new Uint8Array(Buffer.from('not a vcf\n'))]), 'child.vcf');
    const rej = await fetch(`${BASE}/api/trios/audit`, { method: 'POST', body: fd });
    const rejJson = await rej.json();
    check('返回 400 与稳定原因码', rej.status === 400 && !!rejJson?.error?.code, rejJson);
  } catch (err) {
    failures += 1;
    console.error('冒烟执行异常：', err);
  } finally {
    if (proc) {
      await new Promise<void>((resolve) => {
        proc!.once('exit', () => resolve());
        proc!.kill('SIGTERM');
        setTimeout(() => {
          if (proc!.exitCode === null) proc!.kill('SIGKILL');
        }, 3000).unref();
      });
    }
  }

  if (failures > 0) {
    console.error(`冒烟失败：${failures} 项检查未通过`);
    process.exit(1);
  }
  console.log('冒烟全部通过');
  process.exit(0);
}

main();
