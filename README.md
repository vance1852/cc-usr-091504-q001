# 校园活动空间协调服务

面向学校总务与活动负责人的空间协调系统：把教室可用时段、安全容量、无障碍条件、固定设备、清场时间和活动需求纳入统一的冲突判断，让场地确认、临时封闭、活动迁移和责任交接都有明确依据，避免学生、家长和保洁人员收到互相矛盾的安排。

## 技术栈

- **NestJS 10 + TypeScript**：模块化 API（venues / bookings / handovers / approvals / closures / notifications / schedule）
- **SQLite 持久化**：使用 Node 22 内置 `node:sqlite`（无需原生编译），默认落盘 `./data/campus.db`，`DATABASE_PATH` 可配置
- **Jest + supertest**：领域规则单元测试 + 全流程 e2e 测试（48 个用例）

## 快速开始

```bash
npm install
npm test              # 运行全部测试
npm run build         # 编译到 dist/
npm start             # 启动（默认 :3000，DATABASE_PATH=./data/campus.db）
```

身份模型（简化）：请求头 `x-user-id` + `x-user-role`（`organizer` 活动负责人 / `staff` 总务 / `approver` 审批人）。

## 核心规则

### 冲突判断（确认预约时，`src/domain/conflicts.ts`）

| 判断项 | 结果 |
|---|---|
| 时段重叠、场地封闭、超出可用时段、固定设备缺失、时间非法 | **硬冲突**，409 拒绝并返回结构化依据 |
| 超出安全容量（消防）、无障碍通道不可用 | **可豁免**，需对应类型的例外批准（`FIRE_CAPACITY` / `SPECIAL_ACCESS`） |
| 与相邻场次间隔 < 清场缓冲 | 允许确认，但自动生成**交接单**，前后责任人分别确认后后场才能签到 |

### 场地版本

场地任何影响安排的属性（容量/无障碍/设备/可用时段/清场缓冲/状态）变更都会使 `version` 自增，并在 `venue_versions` 留下完整快照。每次确认把当时的场地版本写入预约（`venueVersion`），查询时返回 `confirmationBasis`（依据版本 vs 当前版本、是否已过期 stale）。

### 幂等与并发

- 创建预约支持 `Idempotency-Key` 请求头：重复提交返回同一条记录（`replayed: true`）；Key 相同内容不同返回 409
- 确认在单个事务内完成"检查冲突 + 写入"，并发确认同一时段只有一个成功，不会双重占用
- 确认、签到、交接确认均为幂等操作

### 临时封闭（总务）

`POST /venues/:id/closures` 在单个事务内：封闭场地（版本自增）→ 找出受影响预约 →
- **未开始**：搜索满足全部硬条件的替代场地并迁移（记录新场地版本，通知受影响人群）
- **无法安置**：转入 `DISPLACED`，记录每个候选场地被拒的明确原因
- **已开始**：不静默迁移，标记 `MANUAL_REQUIRED` 需现场人工协调

### 权限

- 活动负责人只能查看/修改**本人项目**（他人 403）
- 场地登记、状态维护、封闭/重开、通知派发仅**总务**
- 例外批准仅**审批人**；已处理的申请不可重复处理

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/venues` | 登记场地（staff） |
| GET | `/venues` / `/venues/:id` | 场地列表 / 详情 |
| PATCH | `/venues/:id` | 维护场地属性与状态（staff，自动升版本） |
| GET | `/venues/:id/versions` | 场地版本快照历史 |
| POST | `/venues/:id/closures` | 临时封闭（staff），返回迁移/无法安置/人工处理影响清单 |
| GET | `/venues/:id/closures` | 封闭记录与影响回溯 |
| POST | `/venues/:id/reopen` | 重开场地（staff） |
| POST | `/bookings` | 创建预约（支持 `Idempotency-Key`） |
| GET | `/bookings` / `/bookings/:id` | 列表（负责人仅见本人）/ 详情（含事件、通知、交接、批准） |
| PATCH | `/bookings/:id` | 修改本人 PENDING 预约 |
| POST | `/bookings/:id/confirm` | 确认（幂等；409 返回冲突依据） |
| POST | `/bookings/:id/cancel` | 取消（本人或总务，通知受影响人群） |
| POST | `/bookings/:id/check-in` | 签到开始（交接未完成则 409） |
| POST | `/bookings/:id/complete` | 结束 |
| POST | `/bookings/:id/exceptions` | 申请消防容量/特殊通行例外 |
| GET | `/approvals` | 批准列表（approver/staff） |
| POST | `/approvals/:id/approve` `/reject` | 审批（approver） |
| GET | `/handovers/:id` | 交接单（含待清场事项） |
| POST | `/handovers/:id/confirm-out` | 前责任人确认清场（可逐项勾选 `items`） |
| POST | `/handovers/:id/confirm-in` | 后责任人确认接收 |
| GET | `/notifications` | 通知查询（`?status=` `?bookingId=`） |
| POST | `/notifications/dispatch` | 派发待发送通知（staff） |
| GET | `/schedule?from=&to=&venueId=` | **时段总览**：实际使用者、待清场事项、冲突依据（确认版本）、受影响人群、变更通知状态 |

## 目录结构

```
src/
  domain/        # 类型、时间工具、冲突判断（纯函数，可单测）
  database/      # node:sqlite 适配、Schema、行映射、事务
  common/        # 身份守卫、领域错误、校验
  venues/        # 场地与版本快照
  bookings/      # 预约生命周期、幂等确认、完整视图
  handovers/     # 责任交接（前后责任人分别确认 + 清场事项）
  approvals/     # 消防容量/特殊通行例外批准
  closures/      # 临时封闭：迁移 / 无法安置原因 / 不静默迁移
  notifications/ # 受影响人群变更通知（PENDING → SENT）
  schedule/      # 任一时段总览查询
test/            # 单元测试 + e2e（含周五双重确认场景还原）
```
