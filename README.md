# 校园活动空间协调服务

面向学校总务与活动负责人的场地协调 API：把**可用时段、安全（消防）容量、无障碍条件、固定设备、清场时间、活动需求**统一纳入冲突判断，所有确认单永久保留当时所依据的**场地版本**，让临时封闭、活动迁移、责任交接与通知都有明确依据，避免学生、家长、保洁收到互相矛盾的安排。

技术栈：Node.js 22 + TypeScript（严格模式）+ NestJS 10 + SQLite（内置 `node:sqlite`，无需原生编译）+ Jest / supertest 自动化测试。

## 运行

```bash
npm install
npm run build
npm start                 # 默认 campus.sqlite，端口 3000
# 可选环境变量
DB_FILE=campus.sqlite PORT=3000 \
INITIAL_STAFF_ID=staff_logistics INITIAL_STAFF_NAME=总务处管理员 npm start

npm test                  # 27 个自动化测试（单元 + 端到端）
```

首次启动若库中无用户，会自动引导一位初始总务账号（默认 `staff_logistics`），此后用户登记走鉴权接口。所有接口需携带请求头 `x-user-id: <用户id>` 标识调用者；角色为 `owner`（活动负责人）、`staff`（总务/保洁）、`approver`（安全审批员）。

## 核心规则

### 冲突判断（`src/domain/conflict.engine.ts`）

| 维度 | 性质 | 说明 |
|---|---|---|
| 时段重叠（含双方清场缓冲） | 硬冲突 | 左闭右开；上一场结束 + 清场时间后下一场才能开始 |
| 周历可用时段 | 硬冲突 | 活动必须落在场地周历开放窗内 |
| 临时封闭 | 硬冲突 | 封闭区间与活动时段相交即不可用 |
| 固定设备缺失 | 硬冲突 | 不可通过批准豁免 |
| 无障碍（轮椅）不满足 | 硬冲突 | 备用场地无障碍通道维修时**不得安置**轮椅需求活动 |
| 消防容量超标 | **可例外** | 需 `approver` 授予 `fire_capacity` 批准 |
| 特殊通行要求 | **可例外** | 需 `approver` 授予 `special_access` 批准 |

申请结果三态：`confirmed`（立即出确认单）/ `pending_approval`（仅有软冲突、占位待批，他人仍不能占用）/ `rejected`（有硬冲突，附完整冲突依据，不占用）。

### 场地版本化

容量、无障碍、设备、周历、清场时间的任何修改都由总务发布**新版本**；确认单写入并永久保留当时的版本快照（`venue_snapshot` + `venue_version_id`），事后修改不改变历史确认依据。

### 临时封闭与迁移（不静默）

`POST /closures` 登记封闭后，对每个受影响的已确认活动：

- **已开始的活动**：`immovable`，不迁移、保留原安排，发出现场处置警示——已经开始的活动不可静默迁移；
- **未开始的活动**：枚举其余场地，给出全部**满足硬条件**的备选（可直接用 / 仅需例外批准分别标注）；无可行场地时 `no_alternative`，**逐场地列明不可安置原因**；
- 迁移必须由**活动负责人显式接受**备选才生效：原单取消、新单以 `replacement_of` 接续、按候选场地当前版本重新评估，防止等待期间产生新占用。

### 交接与重复占用

- 同场地相邻活动自动生成交接单，必须**前序责任人确认交出、后序责任人确认接收**，两侧齐备才成立；旁人不可代确认；
- 重复请求携带相同 `idempotencyKey` 返回原单（`reused: true`），数据库唯一索引兜底，不产生双重占用。

### 权限

- 负责人只能修改本人活动（服务层强制 owner 校验），只能取消本人申请、接受本人迁移方案、确认本人侧交接；
- 总务负责场地登记、版本发布、停用、临时封闭、通知投递；
- 消防容量、特殊通行例外只有 `approver` 可批准。

## 主要接口

| 方法 & 路径 | 角色 | 用途 |
|---|---|---|
| `POST /users` | staff | 登记用户 |
| `POST /venues` · `POST /venues/:id/versions` · `POST /venues/:id/deactivate` | staff | 场地与版本管理 |
| `GET /venues` · `/venues/active` | 任意 | 场地查询 |
| `POST /activities` · `PATCH /activities/:id` · `GET /activities/mine` | owner | 本人项目维护 |
| `POST /bookings/evaluate` | 任意 | 试评估，不占用，返回冲突依据 |
| `POST /bookings` | owner | 提交申请（可带 `idempotencyKey`） |
| `GET /bookings/:id` | 任意 | 确认单详情（含版本快照、审批、通知状态） |
| `POST /bookings/:id/approvals` | approver | 消防容量 / 特殊通行例外批准 |
| `POST /bookings/:id/cancel` | owner/staff | 取消（已开始保留清场责任） |
| `GET /bookings?from=&to=&venueId=` | 任意 | 时间窗实际使用者与占位 |
| `GET /bookings/handovers/list` · `POST /bookings/handovers/:id/confirm` | 本人 | 前后责任人分别交接确认 |
| `GET /bookings/cleanup/list` · `POST /bookings/cleanup/:id/done` | staff | 待清场事项与销项 |
| `POST /closures` | staff | 登记临时封闭，返回各活动处置与备选 |
| `GET /closures` · `/closures/:id` | 任意 | 封闭记录与逐活动影响依据 |
| `POST /closures/proposals/:id/accept` · `/reject` | owner | 显式接受 / 拒绝迁移方案 |
| `POST /notifications/dispatch` · `GET /notifications/status?venueId=` | staff | 通知投递与状态查询 |
| `GET /overview/situation?from=&to=&venueId=` | 任意 | 一窗汇总：实际使用者、待清场、冲突依据、封闭、受影响人群、通知状态 |

通知按**负责人本人 + 每个受影响人群标签**（如 学生 / 家长 / 保洁人员）分别入队，`pending → sent` 状态可查，保证不同人群收到同一版本的安排。

## 目录

```
src/
  db/            SQLite 连接、schema（版本/封闭/确认/审批/交接/清场/通知/迁移）
  domain/        冲突引擎与领域类型（无框架依赖，可独立单测）
  venues/        场地与版本管理（仅总务可写）
  activities/    活动项目（仅本人可改）
  bookings/      申请、确认单快照、审批、交接、清场、时段查询
  closures/      临时封闭、替代方案、显式迁移
  notifications/ 受影响人群通知与投递状态
  overview/      时间窗综合态势
test/
  conflict-engine.spec.ts   冲突规则单元测试
  bookings.e2e-spec.ts      双占用/幂等/版本快照/审批/交接/清场
  closures.e2e-spec.ts      封闭/不静默迁移/已开始不可移/无备选原因/通知/遗留双确认单
```
