# postmcp v2.0 规划路线图

> 本文档记录了 v1.x 中已识别的未实现功能，作为 v2.0 的开发规划。
> 当前版本已完成：核心请求测试、断言引擎、链式测试、WebSocket、Diff、历史审计、OAuth2 CRD、环境/项目管理、导入导出等全部基础能力。

---

## 🎯 战略目标

v2.0 的核心目标是：**让 postmcp 从一个 AI 驱动的 API 测试工具，进化为一个可协作、可集成、可扩展的 API 测试平台**。

---

## 📦 一、导入/导出生态（P0 - 最高优先级）

### 1.1 Postman Collection 完整导入

**现状**: 已实现基础 Collection v2 JSON 导入，支持请求方法和 URL 的解析展示。

**2.0 增强**:
- [ ] 将 Postman Collection 中的请求直接映射为 `test_run_suite` 的步骤
- [ ] 解析 Postman 环境变量文件 (`.postman_environment.json`) 并导入为 `env_configure` 配置
- [ ] 支持 Collection v2.1 格式
- [ ] 支持 Postman 预请求脚本 (Pre-request Script) 的基本转换
- [ ] 支持从 URL 导入（直接从 Postman 分享链接拉取）

### 1.2 Insomnia / Hoppscotch 导入

- [ ] 解析 Insomnia 导出的 JSON ( insomnia_import )
- [ ] 解析 Hoppscotch Collection JSON
- [ ] 统一导入后保留原始来源标签

### 1.3 OpenAPI/Swagger 生成测试用例

- [ ] 从 Swagger/OpenAPI spec 自动生成 `test_run_suite` 测试步骤（每个 endpoint 生成一个步骤）
- [ ] 支持为每个响应码生成断言模板（status 200/400/500）
- [ ] 支持从 spec 中提取 example 值作为请求体模板

---

## 🔀 二、条件分支与高级流控（P0）

### 2.1 条件执行（IF-THEN-ELSE）

**场景**: 步骤 A 如果返回 200 则执行步骤 B，否则执行步骤 C（降级处理）。

```
suite_steps:
  - stepName: "Check Feature Flag"
    url: "/api/feature/flag"
    method: "GET"
    conditions:
      - if: { type: "body", property: "$.enabled", operator: "equals", expected: true }
        then: { continueTo: "Create Order" }
        else: { continueTo: "Fallback Path" }
```

- [ ] 步骤级条件判断（基于断言结果/状态码/响应体判断）
- [ ] 条件跳转（`continueTo` 指定下一步）
- [ ] 循环支持（`repeat` 直到条件满足）

### 2.2 变量快照与回滚（沙箱模式）

**场景**: 测试套件运行后变量被修改，影响下一次运行结果。

- [ ] `test_run_suite` 支持 `sandbox: true` 参数
- [ ] 运行前自动快照所有环境变量
- [ ] 运行结束（无论成败）自动恢复快照
- [ ] 支持手动 `suite_rollback(suiteRunId)` 恢复到运行前状态

### 2.3 并行步骤执行

- [ ] 支持 `mode: "parallel"` 模式，多个步骤同时执行
- [ ] 等待所有并行步骤完成再继续后续步骤
- [ ] 并行步骤间禁止变量提取竞争

---

## 🧪 三、CI/CD 与 CLI 模式（P1）

### 3.1 CLI 命令行入口

```
# 运行测试套件
postmcp run <suite-name|suite-id> [--env prod] [--report json|markdown]

# 导出/导入项目
postmcp export project --id 1 --output ./backup.json
postmcp import project --file ./backup.json

# 数据库管理
postmcp db status
postmcp db reset --confirm

# 批量测试
postmcp test --suite-file ./suites/smoke-test.json --reporter junit
```

- [ ] 新增 `src/cli.ts` 入口，支持 Commander 或 yargs CLI 框架
- [ ] 支持 `--env` 指定运行环境
- [ ] 支持 `--reporter` 输出格式（markdown / json / junit / html）
- [ ] 支持退出码（0=全通过，1=有失败，2=执行错误）
- [ ] 支持 `.postmcp.yml` 配置文件（默认项目和环境）

### 3.2 JUnit / HTML 报告

- [ ] 生成 JUnit XML 报告（Jenkins/GitLab CI 兼容）
- [ ] 生成 HTML 可视化报告（含请求/响应详情、时间线、Diff 可视化）
- [ ] 报告支持嵌入截图（浏览器 API 测试场景）

### 3.3 CI 环境变量注入

- [ ] 支持从环境变量 `POSTMCP_*` 读取配置
- [ ] 支持 `.env` 文件加载
- [ ] CI 模式下自动禁用交互式功能（如 WebSocket waitForPattern）

---

## 🔐 四、企业级认证（P1）

### 4.1 OAuth2 全面支持

| Grant Type | 状态 | 说明 |
|-----------|------|------|
| `client_credentials` | ✅ 已支持 | Basic Auth + Body 兜底 |
| `password` | ✅ 已支持 | username + password |
| `authorization_code` | ❌ 未实现 | 需要浏览器交互（可通过 device code flow 模拟） |
| `refresh_token` | ❌ 未实现 | 自动刷新过期的 access_token |
| `jwt_bearer` | ❌ 未实现 | 使用 JWT 作为断言获取 token |

- [ ] `authorization_code` 通过 device authorization grant 间接支持
- [ ] `refresh_token`：token 过期后自动使用 refresh_token 换新
- [ ] `jwt_bearer`：支持客户端用 JWT assertion 换取 token
- [ ] Token 缓存扩展：存储 refresh_token、token 类型、scope 等信息

### 4.2 多因素/自定义认证

- [ ] 自定义认证 Headers 注入脚本（`authScript`）
- [ ] Digest Authentication
- [ ] Hawk / AWS Signature V4
- [ ] mTLS 客户端证书配置

### 4.3 认证失败自动重试

- [ ] `auth_retry_count`：Token 换失败后自动重试次数
- [ ] `auth_retry_interval`：重试间隔（毫秒）
- [ ] 告警 Hook：认证失败时回调 Webhook 通知

---

## 📊 五、高级测试功能（P2）

### ✅ 5.1 数据驱动测试（DDT） — 已在 v1.x 实现

- [x] 从 CSV / JSON 文件读取测试数据
- [x] 数据模板 + 变量映射，自动生成多组测试步骤
- [x] 支持 `{{row.columnName}}` 引用行数据
- [x] 示例：
  ```json
  {
    "suiteName": "User Creation DDT",
    "dataSource": { "type": "csv", "filePath": "./users.csv" },
    "steps": [...]
  }
  ```

### 5.2 性能测试（基准模式）

- [ ] `test_run_suite` 支持 `mode: "benchmark"` 参数
- [ ] 多次执行并统计 P50/P90/P99 响应时间
- [ ] 生成性能趋势报告
- [ ] 与历史基准对比，检测性能退化

### 5.3 Mock 服务增强

- [ ] 内置 Mock 服务器 + 动态路由规则配置
- [ ] 支持通过 `mock_create` / `mock_delete` 动态管理 Mock 端点
- [ ] Mock 响应延迟模拟（`latencyMs` 参数）
- [ ] Mock 状态码概率分布（模拟不稳定服务）

### 5.4 gRPC 测试

- [ ] `grpc_request` 工具：发送 gRPC unary 调用
- [ ] 支持 protobuf 反射或导入 .proto 文件
- [ ] gRPC 流式调用支持（server streaming / client streaming）

---

## 🤝 六、团队协作（P1 — v2.0 核心）

### 6.1 项目模板化与脚手架

- [ ] `project_create` 支持 `--template` 参数（从已有项目复制结构）
- [ ] 预置 API 测试模板（RESTful CRUD / GraphQL / WebSocket）
- [ ] `project_init` 交互式初始化向导

### 6.2 环境配置分享

- [ ] **`env_share`**：生成加密分享链接（Token 脱敏，接收方需自行填入敏感值）
- [ ] **`env_apply`**：应用他人分享的环境配置（自动提示替换 Token）
- [ ] 分享配置含版本号（`env_version`），跟踪配置变更

### 6.3 测试套件协作

- [ ] **`suite_export` / `suite_import`**：导出/导入测试套件为单文件 JSON
- [ ] 套件支持标签/分类（`suite_tag` / `suite_list --tag smoke`）
- [ ] 套件版本控制（`suite_version`，每次 `suite_save` 自动递增）
- [ ] **`suite_diff`**：对比两个版本套件的步骤差异

### 6.4 远程数据库（团队共享）

- [ ] `postmcp --db-url postgresql://user:pass@host/dbname`
- [ ] `postmcp --db-url mysql://user:pass@host/dbname`
- [ ] 数据库迁移脚本（SQLite → PostgreSQL → MySQL）
- [ ] 并发安全：行级锁 + 乐观锁防止多人同时写入同一环境变量
- [ ] 权限模型：项目级读写权限（Owner / Editor / Viewer）

### 6.5 历史审计数据共享

- [ ] **`history_export` 支持加密导出**（AES-256-GCM 加密敏感字段）
- [ ] 导出格式扩展：CSV / PDF / HTML
- [ ] 导出范围：按项目/环境/日期/标签
- [ ] **`history_share`**：生成审计报告分享链接（只读视图）

### 6.6 报告与通知

- [ ] **`test_run_suite` 支持 `--webhook` 回调**（运行完成通知 Slack / DingTalk / Email）
- [ ] 测试报告自动归档（HTML 格式，含请求/响应详情）
- [ ] 失败趋势分析（`history_trend` — 统计最近 N 天失败率变化）

### 6.7 团队工作流

- [ ] **审批流程**：修改环境配置/删除历史需要审批（`env_configure --approve-from userA`）
- [ ] 变更日志（`changelog_list` / `changelog_get` — 记录所有配置变更历史）
- [ ] 评论/注解（`history_comment` — 在历史记录上添加调试备注）

---

## 🛠 七、开发者体验（P2）

### 7.1 插件系统

- [ ] `preRequest` / `postResponse` 钩子脚本（JavaScript Sandbox）
- [ ] 自定义断言插件
- [ ] 自定义报告生成器

### 7.2 Web Dashboard

- [ ] 基于 Web 的可视化测试管理界面（可选，独立于 CLI）
- [ ] 实时测试执行日志流
- [ ] 测试结果趋势图

### 7.3 SDK / API 模式

- [ ] Node.js SDK：`import { PostmcpClient } from 'postmcp'`
- [ ] REST API 模式（非 MCP）：通过 HTTP API 调用 postmcp 功能
- [ ] 为其他语言（Python/Go/Java）生成 SDK 的 OpenAPI spec

---

## 🧹 八、技术债务与优化（P3）

### 8.1 性能优化

- [ ] 大型 JSON 响应的高效解析（流式解析替代完整加载）
- [ ] history 表自动分表/归档（按月/按项目）
- [ ] WebSocket 消息缓冲区大小限制可配置（默认 1000 条）
- [ ] 数据库 WAL 模式提升写入性能

### 8.2 安全增强

- [ ] 数据库文件加密（SQLCipher）
- [ ] Token 在内存中的安全存储（避免 core dump 泄露）
- [ ] 请求/响应日志的自动过期策略（配置化 TTL）
- [ ] 审计日志完整性校验（防止日志被篡改）

### 8.3 可观测性

- [ ] 结构化日志（pino / winston）
- [ ] OpenTelemetry 链路追踪
- [ ] Prometheus 指标暴露（请求数、延迟分布、错误率）
- [ ] Health check 端点

---

## 📐 九、架构变更（基础支撑）

### 9.1 可插拔认证器

```
Authenticator 接口:
  - OAuth2ClientCredentials
  - OAuth2Password
  - OAuth2AuthorizationCode
  - BasicAuth
  - DigestAuth
  - AWSSigV4
  - CustomScript
```

- [ ] 注册式认证器管理，`auth_register` / `auth_unregister`
- [ ] 认证器链（fallback 多个认证方式）

### 9.2 事件系统

- [ ] `onRequestStart` / `onRequestComplete` / `onAssertionFail`
- [ ] Webhook 通知（Slack / DingTalk / Email）
- [ ] 支持自定义事件处理器写入

---

## 📋 版本规划时间线

| 里程碑 | 版本 | 核心交付 | 预估 |
|--------|------|---------|------|
| 🚀 数据驱动 & 沙箱 | **v2.0.0-alpha** | DDT、沙箱模式、CLI 基础 | 2-3 周 |
| 🚀 CI/CD 集成 | **v2.0.0-beta** | CLI 完整、JUnit 报告、CI 模式 | 4-6 周 |
| 🚀 企业认证 | **v2.0.0-rc1** | 完整 OAuth2、mTLS、重试 | 6-8 周 |
| 🚀 协作 | **v2.0.0** | 导入导出生态、远程 DB、插件系统 | 8-12 周 |
| 🚀 性能 | **v2.1.0** | 基准测试、gRPC、性能优化 | 12-16 周 |
| 🚀 Dashboard | **v2.2.0** | Web 界面、SDK、可视化报告 | 16-20 周 |

---

> **贡献指南**: 欢迎提交 Issue 和 PR 来推进 v2.0 的任何功能点。
> 标记为 P0/P1 的功能是下个版本的必达目标。
