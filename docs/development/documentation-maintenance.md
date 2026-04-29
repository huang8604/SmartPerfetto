# 文档维护规则

本文档说明 docs 体系的维护边界。目标是让开源用户看到稳定入口，让内部设计过程有归档位置，但不再污染权威文档。

## 分类规则

| 类型 | 放置位置 | 要求 |
|---|---|---|
| 用户入门 | `docs/getting-started/` | 能直接跑通，不写内部 TODO |
| 当前架构 | `docs/architecture/` | 与当前代码一致，过期内容移入 archive |
| API/CLI/DSL 参考 | `docs/reference/` | 以源码和命令为准 |
| 开发流程 | `docs/development/` | 包含验证命令 |
| 运行故障 | `docs/operations/` | 面向真实部署和本地开发 |
| 产品介绍 | `docs/product/` | 面向外部读者 |
| 历史方案/spike | `docs/archive/` | 明确标记历史状态 |
| 渲染管线知识库 | `docs/rendering_pipelines/` | 文件名是运行时契约，谨慎改名 |

## Archive 规则

以下内容进入 `docs/archive/`：

- 已完成的阶段性计划。
- SDK spike 记录。
- 不再代表当前推荐方案的 review 文档。
- 保留背景价值但不适合作为用户入口的长文。

Archive 文档顶部应能看出状态，或由目录 README 标记整体状态。

## 链接规则

- 根 README 只链接 `docs/README.md` 和少量高频文档。
- 新用户路径从 `docs/README.md` 出发。
- 不从 README 直接链接历史 proposal。
- 从代码注释链接设计文档时，优先链接 `docs/architecture/` 或 `docs/reference/` 下的当前权威文档。

## 运行时文档规则

`docs/rendering_pipelines/*.md` 会被教学模式读取。新增或改名时同步：

```text
backend/skills/pipelines/*.skill.yaml
backend/skills/atomic/rendering_pipeline_detection.skill.yaml
backend/src/services/pipelineDocService.ts
backend/src/config/teaching.config.ts
```

验证：

```bash
cd backend
npm run validate:skills
npm run test:scene-trace-regression
```

## Prompt 文档规则

`backend/strategies/*.strategy.md` 和 `*.template.md` 是运行时 Prompt，不属于普通 docs。改动后运行：

```bash
cd backend
npm run validate:strategies
npm run test:scene-trace-regression
```

## 检查建议

提交前至少检查：

```bash
find docs -name '*.md' | sort
rg -n "docs/(technical-architecture|mcp-tools-reference|skill-system-guide|self-improving-design|context-engineering|v2\\.1|sdk-capability)" . \
  --glob '!docs/development/documentation-maintenance.md'
git diff --check
```

如果改动包含 `.ts` 或 `.yaml`，按 [测试与验证](testing.md) 执行。
