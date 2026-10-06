#!/bin/sh
# 一次性校验入口（verify 服务）：
#   1) TypeScript 构建
#   2) 代码测试（node --test）
#   3) 三人组 API 冒烟（SMOKE_BASE_URL 已设置时打外部 api 服务，否则自起临时实例）
# 三项结果以退出码汇总：全部通过退出 0，任一失败退出 1。

cd "$(dirname "$0")/.." || exit 2

overall=0

echo "== [1/3] TypeScript 构建 (npm run build) =="
if npm run build; then
  echo "   [PASS] TypeScript 构建"
else
  echo "   [FAIL] TypeScript 构建"
  overall=1
fi

echo "== [2/3] 代码测试 (npm test) =="
if npm test; then
  echo "   [PASS] 代码测试"
else
  echo "   [FAIL] 代码测试"
  overall=1
fi

echo "== [3/3] 三人组 API 冒烟 (npm run smoke) =="
if npm run smoke; then
  echo "   [PASS] API 冒烟"
else
  echo "   [FAIL] API 冒烟"
  overall=1
fi

echo "----------------------------------------"
if [ "$overall" -eq 0 ]; then
  echo "verify 汇总：构建 / 测试 / 冒烟全部通过 (exit 0)"
else
  echo "verify 汇总：存在失败项 (exit 1)"
fi
exit "$overall"
