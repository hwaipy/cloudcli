# 2026-11-13 仓库审计与重构

## 范围与方法

审计基于原工作区（含其未提交功能）的独立快照，worktree 为 `../cloudcli-review`，分支为 `refactor/repository-audit-20261113`。基线前端为 1084 项测试。使用 TypeScript 未使用声明检查、Knip 引用图、全仓文本引用搜索及人工调用链核对；Knip 结果需结合动态 provider、CLI、Electron 和原生客户端入口解释，不直接自动删除。

本轮删除 20 个确认无运行调用的文件（这些文件共 1918 行），另清理残留函数、类型、无效 props 和未使用 imports。现有文件合计净减少约 2372 行；新增两份后端回归测试和本文档。移除 3 个只覆盖已移除界面的旧测试文件，保留当前产品链路的回归测试。

## 已修复的行为问题

1. **VAPID 数据库生命周期**：旧服务在模块导入时捕获数据库连接，并在进程级缓存密钥。隔离测试确认切换数据库后仍返回前一数据库的公钥。现通过 `vapidKeysDb.getOrCreateVapidKeys()` 的事务读取或生成，保留原数据库已有密钥，不做迁移或轮换。`vapid-key-lifecycle.test.ts` 修复前失败、修复后通过。
2. **同步回执订阅泄漏**：普通发送、Steer、问题回答和队列 Steer 原有四份回执/超时/取消代码。现由一个私有 receipt observer 管理会话与请求 ID 过滤、一次性完成和清理。同步回放早于 `subscribe()` 返回 disposer 时也能清理。保留各路径原来的超时时长、回退及输入保留行为；同步重试回归用旧代码失败、重构后通过。
3. **测试库隔离**：13 个 Codex runtime 测试原先依赖默认数据库已有 schema。补齐临时数据库夹具，完整测试使用隔离 fallback 数据库，不读取生产聊天库。
4. **易抖动的测试断言**：编辑拒绝等待 `RUN_IN_PROGRESS` 协议结果，而不是固定 30ms 后假设最后一帧；CLI 超时测试检查 updater 与子进程实际没有完成，不再把版本探测和机器负载计入脆弱的总耗时上限。

## 结构重构

- Claude 历史展示与会话全文搜索统一使用 shared 的标签解析和命令格式化，实现一致的用户可见文本。保留多行、缺失标签、旧格式回退及正则转义语义。
- VAPID 服务移除重复 SQL 和整文件 `ts-nocheck`，持久化职责归 database repository。
- 移除已下线快捷工具面板、Star、旧 GitHub 创建 UI/克隆前端链路及旧 WebSocket writer。后台 GitHub 凭据、克隆接口、当前设置和网关 writer 保留。
- 清理只传递但最终组件不消费的设置/权限回调 props；真正的权限请求操作仍保留。
- Hub 静态资源响应不再为已经不使用的参数反复构建后端列表；后端选择与 API 路由不变。
- 删除未使用的直接依赖 `fuse.js`、`node-fetch`、`rehype-raw`，以及开发依赖 `auto-changelog`，同步 lockfile；没有升级其他依赖。
- 前后端启用 `noUnusedLocals` 和 `noUnusedParameters`。Express 错误处理中间件保留四参数签名，用下划线标记未使用参数，避免改变中间件识别语义。

## 删除清单

- `server/modules/websocket/services/websocket-writer.service.ts`
- `src/modules/project-creation-wizard/GithubAuthenticationCard.tsx`
- `src/modules/project-creation-wizard/hooks/useGithubTokens.ts`
- `src/modules/project-creation-wizard/tests/workspaceApi.test.ts`
- `src/modules/quick-settings-panel/QuickSettingsCommandsTab.tsx`
- `src/modules/quick-settings-panel/QuickSettingsContent.tsx`
- `src/modules/quick-settings-panel/QuickSettingsHandle.tsx`
- `src/modules/quick-settings-panel/QuickSettingsPanelHeader.tsx`
- `src/modules/quick-settings-panel/QuickSettingsPanelView.tsx`
- `src/modules/quick-settings-panel/QuickSettingsSection.tsx`
- `src/modules/quick-settings-panel/QuickSettingsTabs.tsx`
- `src/modules/quick-settings-panel/QuickSettingsToggleRow.tsx`
- `src/modules/quick-settings-panel/hooks/useQuickSettingsDrag.ts`
- `src/modules/quick-settings-panel/hooks/useQuickSettingsPanelState.ts`
- `src/modules/quick-settings-panel/index.ts`
- `src/modules/quick-settings-panel/tests/quickSettingsPanelState.test.ts`
- `src/modules/quick-settings-panel/tests/voiceToggleVisibility.test.tsx`
- `src/modules/sidebar/GitHubStarBadge.tsx`
- `src/modules/sidebar/hooks/useGitHubStars.ts`
- `src/shared/ui/DarkModeToggle.tsx`

## 验证

- 前端：155 个测试文件、1062 项通过。比基线少的数量来自上述旧界面测试移除，并新增同步回执回归。
- 后端：908 项通过，3 项环境相关跳过；新增生命周期和共享命令解析回归。
- 桌面：21 项通过。
- TypeScript 检查与前后端构建通过，lint 无错误；历史 warnings 未作为重构目标批量改写。
- 手机 WebKit 可变高度滚动回归继续执行，确保此前稳定性修复不被回退。

## 保留与边界

TaskMaster、终端、其他 provider、独立 CLI/桌面打包均有真实入口或接口用途，本轮未视为死代码。静态工具对 JS 动态入口、类型及测试专用导出有误报，均需人工确认。没有删除用户数据库、配置、密钥、历史会话或已归档数据。没有更改 API、消息协议或数据库 schema。

大型会话解析器、路由和 composer 仍包含复杂逻辑；本轮通过清理死路径和合并重复职责降低复杂度，不将文件拆短本身作为完成指标。此次是全仓静态审计加重点链路人工重构，不表示每一行或所有原生平台均已完成手工验证。

后端产物可部署但不得自动重启；前端和 Hub 可按既定约定发布。运行中的后端须由用户手动重启后加载新构建。

## 本轮发布结果

- 重构增量已合回原工作区，合并前逐文件核对，未覆盖其他工作；未创建 Git commit 或 push。
- 前端已发布，版本 `20261113T110529Z-b0c857cd`；6 项公网入口回归通过，实际发布 CSS 的 WebKit 滚动测试通过。
- Hub 已部署并重启，健康检查通过。
- Mac 后端构建已部署；Ubuntu 后端已部署完整构建，PID 仍为 `2060`，未重启。两台后端均需手动重启才完整加载后端重构。
- Mac 与 Ubuntu 聊天数据库已通过 SQLite backup API 做一致性备份；未执行数据库迁移或修改聊天记录。
- 本次增量补丁单独保存在原工作区 `.debug-local/refactor-audit.patch`，便于与其他未提交功能区分。
