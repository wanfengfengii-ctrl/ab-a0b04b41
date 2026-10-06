# 遗传质控平台 · 三人组定相变异核对 (Trio Haplotype Audit)

对 father / mother / child 三份 **UTF-8 VCF 4.2** 文件进行逐区段的单倍型连续传递核对：
即使每个位点单独看都符合遗传规律，只要整段单倍型无法由父母各自一条单倍型连续解释，也会被标记为不一致。

## 规则

- 三个 multipart 字段：`father`、`mother`、`child`，单文件 ≤ **2 MiB**，记录数 **1–2000**。
- 仅接受：二倍体、双等位 SNP；每份恰一个样本；FORMAT 固定 `GT:PS`；GT 完整且已定相（`0|0`/`0|1`/`1|0`/`1|1`）。
- 三份文件须具有**完全相同且严格递增**的 `CHROM,POS,REF,ALT`（各文件内部递增，三方逐行对齐）。
- **裁决区段**：任一成员的 PS 相对上一条记录发生变化即开启新区段。
- 区段内：子代两条有序单倍型必须分别由父亲、母亲各一条单倍型**连续**解释；
  亲本来源与所选亲本同源染色体（hap1/hap2）均不得中途切换。
  - 纯合位点无法区分同源染色体，两条候选均保留，不提前锁定。
- 稳定原因码：
  - 位点级（HTTP 200，区段 verdict=inconsistent，给出首个失败位点）：
    `MENDEL_CONFLICT`、`ORIGIN_SWITCH`（亲本来源切换）、`HAPLOTYPE_SWITCH`（亲本同源染色体切换）。
  - 结构级（HTTP 400，整体拒绝）：`INVALID_FILE`、`UNSUPPORTED_VCF_VERSION`、
    `UNSUPPORTED_VARIANT`、`INVALID_GENOTYPE`、`INVALID_PHASE_SET`、`UNSUPPORTED_FORMAT`、
    `SAMPLE_COUNT_MISMATCH`、`SITE_COUNT_MISMATCH`、`SITES_NOT_ALIGNED`、`EMPTY_VCF`、
    `TOO_MANY_RECORDS`、`FILE_TOO_LARGE`、`MISSING_FILE`。

## 接口

- `GET /health` → `{ "status": "ok", ... }`（容器健康检查）
- `POST /api/trios/audit`：`multipart/form-data`，字段 `father`/`mother`/`child`。

成功响应（200，按区段返回范围与裁决）：

```json
{
  "recordCount": 2,
  "segmentCount": 1,
  "segments": [
    {
      "range": {
        "start": { "index": 1, "chrom": "chr1", "pos": 100, "ref": "A", "alt": "G" },
        "end":   { "index": 2, "chrom": "chr1", "pos": 200, "ref": "A", "alt": "T" }
      },
      "variantCount": 2,
      "verdict": "consistent",
      "assignment": {
        "childHaplotype1": { "parent": "father", "parentalHaplotype": 2 },
        "childHaplotype2": { "parent": "mother", "parentalHaplotype": 1 }
      }
    }
  ]
}
```

不一致区段示例：

```json
{
  "range": { "start": { "index": 1, "...": "..." }, "end": { "index": 2, "...": "..." } },
  "variantCount": 2,
  "verdict": "inconsistent",
  "failure": {
    "index": 2,
    "site": { "index": 2, "chrom": "chr1", "pos": 200, "ref": "A", "alt": "G" },
    "reasonCode": "HAPLOTYPE_SWITCH",
    "message": "continuous haplotype transmission breaks at chr1:200: ..."
  }
}
```

结构错误（整体拒绝）：`{ "error": { "code": "SITES_NOT_ALIGNED", "message": "...", "record": 3 } }`。

## 本地运行（Node ≥ 22）

```bash
npm ci
npm run verify    # build + 单元测试 + 真实 HTTP 冒烟；全过退出码 0
npm start         # 启动 API（PORT 环境变量，默认 8080）
```

调用示例：

```bash
curl -f http://localhost:8080/health
curl -f -X POST http://localhost:8080/api/trios/audit \
  -F father=@father.vcf -F mother=@mother.vcf -F child=@child.vcf
```

## Docker

```bash
# 宿主机端口可配置
HOST_PORT=9090 docker compose up -d api

# 一次性验证服务：构建 + 测试 + 对 api 服务的冒烟，自行退出并以退出码汇总结果
docker compose up --build verify
docker compose ps   # verify 状态 Exited (0) 即全部通过
```

## 项目结构

```
src/
  parser.ts    # 严格的 VCF 4.2 解析与结构校验
  auditor.ts   # PS 区段切分 + 连续单倍型传递裁决
  app.ts       # Express / multipart 上传 / 响应与错误码
  server.ts    # HTTP 入口
  smoke.ts     # 端到端冒烟（默认自建子进程；BASE_URL 时直接打远端）
  test/        # node:test 单元测试
```
