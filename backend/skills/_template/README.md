# Skills Templates

S/A/B 三档 skill 模板 + vendor override 模板。配套
`docs/reference/skill-system.md` 的 "Skill tier 与校验规则" 使用。

> **重要**: `_template/` 目录被 `SkillRegistry` 自动跳过（不在
> `skillLoader.loadSkillsFromDir` 扫描的 `atomic/`/`composite/`/`deep/`/`system/`
> 等显式目录列表内）—— 这些文件**不会进入 skill 注册表**，也不会被
> `npm run validate:skills` 校验。它们是**纯模板**，复制后才生效。

## 模板清单

| 文件 | 用途 | tier | 依据 |
|------|------|------|------|
| `composite_S_template.skill.yaml` | 跨 stdlib 多阶段编排，对标 `composite/cpu_analysis` | S | 34 个 flagship skill |
| `atomic_S_template.skill.yaml` | atomic 目录 + type=composite 模式（如 `startup_slow_reasons`） | S | 同上特殊变体 |
| `atomic_A_template.skill.yaml` | atomic 单职责但 SQL 实质（≥3 步或 ≥200 行） | A | 15 个 analysis-step skill |
| `atomic_B_template.skill.yaml` | atomic 单事实数据提供者 | B | 72 个 data-provider skill |
| `vendor_override_template.yaml` | OEM 平台特化（hint-based） | n/a | M2-M5 核心 4 领域 vendor 扩展 |

## 复制流程

1. 选对应 tier 的模板，复制到目标目录（atomic/composite/deep/system/vendors）
2. 重命名（`<your_skill_id>.skill.yaml`，snake_case，全 registry 内唯一）
3. 替换全部 `{{...}}` 占位符
4. 删除模板内的注释块和示例占位
5. 跑 `npm run validate:skills` —— 任何 lint rule 失败必须 fix（参见 `docs/reference/skill-system.md`）
6. 加 trace fixture 测试到 `tests/skill-eval/`
7. 跑 `npm run test:scene-trace-regression` 6/6 PASS

## tier 字段

新增的 `tier: S | A | B` 顶层字段会被 `validate:skills` 的 5 条 lint rule
（实现于 `backend/src/cli/commands/validate.ts`）强制校验：
- Rule 1 `skill-tier-must-match-declared` — tier 与实际指标一致
- Rule 2 `skill-stdlib-detected-vs-declared` — SQL 用到的 stdlib ⊂ prerequisites.modules
- Rule 3 `skill-include-budget-soft-cap` — prerequisites.modules ≤ 8
- Rule 4 `skill-step-id-uniqueness`
- Rule 5 `skill-vendor-override-runtime-conformant` — vendor override 必须有 ≥1 真实 step

## 修改模板

修改时请同步更新 `docs/reference/skill-system.md` 的 tier/validation 规则，保持单一事实源。
