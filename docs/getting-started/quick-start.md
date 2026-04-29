# 快速开始

本页用于把 SmartPerfetto 跑起来。更多模型和代理参数见 [配置指南](configuration.md)。

## 1. 克隆仓库

SmartPerfetto 使用 `perfetto/` submodule 承载 fork 后的 Perfetto UI。

```bash
git clone --recurse-submodules https://github.com/Gracker/SmartPerfetto.git
cd SmartPerfetto
```

如果已经普通 clone：

```bash
git submodule update --init --recursive
```

不要使用 GitHub 的 Download ZIP 做本地开发，因为 ZIP 不包含 submodule。

## 2. 准备配置

```bash
cp backend/.env.example backend/.env
```

最小配置是：

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

也可以通过 `ANTHROPIC_BASE_URL` 接入 one-api、new-api、LiteLLM 等 Anthropic 兼容代理。

## 3. Docker 运行

适合只想试用，不想配置本机开发工具链的场景。

```bash
docker compose up --build
```

打开 [http://localhost:10000](http://localhost:10000)，加载 `.pftrace` 或 `.perfetto-trace` 文件，然后打开 AI Assistant 面板。

## 4. 本地开发运行

适合调试、改代码或提交 PR。

```bash
./scripts/start-dev.sh
```

首次启动会安装依赖，并下载 version-pinned 的 `trace_processor_shell` 预编译产物。服务地址：

| 服务 | 地址 |
|---|---|
| Perfetto UI | `http://localhost:10000` |
| Backend API | `http://localhost:3000` |
| Backend health | `http://localhost:3000/health` |

后端 `tsx watch` 和前端 `build.js --watch` 会在保存文件后自动重编译。改 `.ts`、`.yaml`、`.md` 后通常只需要刷新浏览器。

## 5. 第一次分析

1. 打开 `http://localhost:10000`。
2. 加载 Perfetto trace。
3. 打开 AI Assistant。
4. 输入问题：

```text
分析滑动卡顿
```

常用问题：

- `分析启动性能`
- `CPU 调度有没有问题？`
- `帮我看看这个 ANR`
- `这个 trace 的应用包名和主要进程是什么？`

## 6. 必要检查

开发改动后，至少运行：

```bash
cd backend
npm run test:scene-trace-regression
```

更多命令见 [测试与验证](../development/testing.md)。
