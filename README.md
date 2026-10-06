# 三人组已定相变异单倍型连续传递裁决服务（trio-haplotype-audit）

遗传质控平台用 API：对父、母、子代三份 **已定相 VCF 4.2** 逐相位集（PS）区段核对，
避免“单个位点看似符合遗传规律、整段单倍型却无法连续传递”的数据进入下游分析。

- `POST /api/trios/audit`：`multipart/form-data` 上传 `father`、`mother`、`child` 三个 VCF
- `GET /health`：健康检查
- 纯 Node.js（>=22）内置 `node:http` 实现，**零运行时依赖**
- 提供 Dockerfile（多阶段构建）与 Docker Compose；宿主机端口可配置
- 一次性 `verify` 服务以退出码汇总：TypeScript 构建、代码测试、三人组 API 冒烟

## 1. 输入约束（任一不满足 → 4xx 整体拒绝）

| 约束 | 说明 |
| --- | --- |
| 编码 / 版本 | UTF-8、`##fileformat=VCFv4.2` 首行 |
| 大小 | 单文件 ≤ 2 MiB（超出 `413 FILE_TOO_LARGE`） |
| 记录数 | 每份 1～2000 条 |
| 位点 | 三份文件具有**完全相同且严格递增**的 `CHROM,POS,REF,ALT` 序列 |
| 变异类型 | 仅二倍体、双等位 SNP（单碱基 A/C/G/T 替换） |
| 样本 | 每份恰有一个样本列 |
| FORMAT | 固定 `GT:PS`；基因型完整且已定相（`0|0 / 0|1 / 1|0 / 1|1`，不接受 `/`、`.`、多等位） |
| PS | 非负整数；任一成员 PS 相对上一位点变化即开启新区段 |

## 2. 裁决规则

1. 按位点顺序对齐三份文件；记录数或任一四元组不一致 → `400` 整体拒绝
  （`TRIOS_RECORD_COUNT_MISMATCH` / `TRIOS_LOCI_MISMATCH`）。
2. **区段切分**：父、母、子任一成员的 PS 发生变化，即在该位点前开启新裁决区段。
3. 区段内枚举 8 种固定分配（孩子 h1/h2 的亲本来源 2 种 × 各自选择亲本单倍型 2×2），
   逐位点收窄可行集：
   - 全部位点被同一分配覆盖 → `CONSISTENT`，返回固定的亲本/单倍型分配；
   - 否则在**首个失败位点**裁决 `INCONSISTENT`，给出稳定原因码：
     - `CHILD_ALLELE_IMPOSSIBLE`：孩子的等位组合无法由父亲、母亲各提供一个等位构成
       （如某等位父母皆无，或仅有一方具备而孩子两条等位都需要它，违反孟德尔遗传）；
     - `HAPLOTYPE_SWITCH_WITHIN_SEGMENT`：等位本身可由父母提供，但无法由父母各一条
       单倍型连续解释——亲本来源或所选亲本单倍型不得不在段内切换。

> 遗传/相位不一致属于正常裁决结果，HTTP 状态为 **200**，不一致体现在区段 `verdict`；
> 文件结构或三方位点不对齐才会整体 4xx 拒绝。

## 3. 成功响应示例

```json
{
  "status": "ok",
  "totalVariants": 3,
  "segments": [
    {
      "index": 1,
      "startChrom": "chr1",
      "startPos": 100,
      "endChrom": "chr1",
      "endPos": 102,
      "variantCount": 3,
      "phaseSets": { "father": "1", "mother": "1", "child": "1" },
      "verdict": "CONSISTENT",
      "assignment": {
        "childHaplotype1": { "parent": "father", "haplotype": 1 },
        "childHaplotype2": { "parent": "mother", "haplotype": 1 }
      },
      "firstFailure": null
    }
  ]
}
```

不一致区段：

```json
{
  "verdict": "INCONSISTENT",
  "assignment": null,
  "firstFailure": {
    "chrom": "chr1", "pos": 102, "ref": "A", "alt": "T",
    "reasonCode": "HAPLOTYPE_SWITCH_WITHIN_SEGMENT",
    "reason": "区段内无法由父母各一条单倍型连续解释：……"
  }
}
```

## 4. 本地运行与开发

```bash
npm install --cache ./.npm-cache   # 仅 dev 依赖：typescript、@types/node
npm run build                       # tsc → dist/
npm test                            # node:test 单元 + HTTP 测试（30 项）
npm start                           # 启动 API（PORT 默认 8080）
npm run smoke                       # 自起临时服务做三人组冒烟
npm run verify                      # 构建 + 测试 + 冒烟，退出码汇总
```

curl 冒烟：

```bash
curl -s http://localhost:8080/health
curl -s -X POST http://localhost:8080/api/trios/audit \
  -F father=@examples/father.vcf \
  -F mother=@examples/mother.vcf \
  -F child=@examples/child.vcf
```

## 5. Docker 与 Docker Compose

```bash
# 构建并以后台服务方式运行（宿主机端口可配置）
HOST_PORT=18080 docker compose up -d --build api

# 一次性校验服务：等待 api 健康 → 构建/测试/冒烟 → 自行退出
docker compose run --rm verify
# 查看退出码：全部通过为 0，任一失败为 1
docker inspect trio-verify --format '{{.State.ExitCode}}' 2>/dev/null || \
  echo "（run --rm 容器已删除；可用 --name 或 compose 日志确认）"
```

- `api`：多阶段构建的 runtime 镜像，内置容器 HEALTHCHECK（`/health`）。
- `verify`：使用 builder 阶段（含 devDependencies 与编译工具链），`restart: "no"`，
  跑完即退；通过 compose 网络以 `SMOKE_BASE_URL=http://api:8080` 对真实 api 容器冒烟。
- 宿主机端口：`.env` 或环境变量 `HOST_PORT`（默认 `8080`）映射到容器固定 `8080`。

## 6. 错误原因码

| HTTP | code | 触发场景 |
| --- | --- | --- |
| 400 | `MALFORMED_VCF` / `MALFORMED_HEADER` / `MALFORMED_RECORD` | VCF 结构非法 |
| 400 | `UNSUPPORTED_VCF_VERSION` | 首行非 VCFv4.2 |
| 400 | `NOT_SNP` / `NOT_BIALLELIC` | 非单碱基 SNP 或非双等位 |
| 400 | `UNEXPECTED_FORMAT` | FORMAT 不是 `GT:PS` |
| 400 | `UNPHASED_OR_INCOMPLETE_GENOTYPE` | 基因型缺失、未相位或含非法等位 |
| 400 | `MALFORMED_PHASE_SET` | PS 非非负整数 |
| 400 | `LOCI_NOT_STRICTLY_INCREASING` | 单文件位点不严格递增 |
| 400 | `EMPTY_VCF` / `TOO_MANY_RECORDS` | 记录数不在 1～2000 |
| 400 | `TRIOS_RECORD_COUNT_MISMATCH` | 三份记录数不同 |
| 400 | `TRIOS_LOCI_MISMATCH` | 同序号位点四元组不一致 |
| 400 | `MISSING_FILE` / `EMPTY_FILE` / `DUPLICATE_FIELD` / `UNEXPECTED_FIELD` / `MALFORMED_MULTIPART` | 上传层问题 |
| 413 | `FILE_TOO_LARGE` / `PAYLOAD_TOO_LARGE` | 单文件或总体积超限 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 非 multipart/form-data |
| 200 | `CHILD_ALLELE_IMPOSSIBLE` / `HAPLOTYPE_SWITCH_WITHIN_SEGMENT` | 区段级裁决原因（业务结果） |

## 7. 目录结构

```
src/
  parser.ts    # VCF 4.2 严格解析与校验
  multipart.ts # multipart/form-data 解析与 2 MiB 限制
  audit.ts     # 位点对齐、PS 区段切分、连续传递裁决
  server.ts    # HTTP 路由：/health、/api/trios/audit
  types.ts errors.ts
  scripts/smoke.ts      # 冒烟（支持自起服务或 SMOKE_BASE_URL）
  tests/                # node:test：裁决、解析、对齐、HTTP 测试
scripts/verify.sh       # 构建+测试+冒烟退出码汇总
Dockerfile docker-compose.yml examples/
```
