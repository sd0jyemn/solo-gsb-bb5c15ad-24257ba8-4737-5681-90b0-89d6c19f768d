# http-cache-lab

一个用于**演练 HTTP 缓存策略**的 API 服务。你可以：

- 预置带 `Cache-Control`、`ETag`、`Vary` 与**存入时间**的模拟响应；
- 携带**虚拟时间**发起请求，观察缓存按 `fresh` / `stale-while-revalidate` / `expired` 的判定；
- 观察并发请求命中同一需回源键时的**单飞回源令牌**（single-flight token）编排；
- 逐步核对每次判定输出的**解释轨迹**（trail）；
- 按方法 + URL + 请求头**精确解析 Vary 变体**做**条件失效**（ETag 守卫、dryRun 预览、释放 pending 令牌、全程留痕）；
- 一键重置整个演练状态。

技术栈：TypeScript · Fastify 4 · better-sqlite3（同步驱动，天然避免回源竞态）。

---

## 快速开始

```bash
docker compose up --build
```

服务在 **http://localhost:8080** 启动，SQLite 数据存放在命名卷 `cache-lab-data` 中。

```bash
curl -s http://localhost:8080/healthz
# {"ok":true,"stats":{"entries":0,"pendingTokens":0,"decisions":0,"invalidations":0}}
```

停止并清空数据卷：

```bash
docker compose down -v
```

在容器内运行端到端断言（内存库、随建随跑，含条件失效场景）：

```bash
docker compose run --build smoke
```

### 不用 Docker（本地开发）

```bash
npm ci
npm run build
DB_PATH=./data/lab.db npm start          # 生产模式
DB_PATH=:memory: npm run dev             # 开发模式（内存库）
npm run smoke                            # 84 项端到端断言
```

环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DB_PATH` | `/data/cache-lab.db` | SQLite 文件路径，`:memory:` 为内存库 |
| `LOG_LEVEL` | `info` | pino 日志级别，演练时建议 `error` |

---

## 30 秒上手

```bash
T0=1767225600000   # 2026-01-01T00:00:00Z，毫秒时间戳

# 1) 预置一个 max-age=60、SWR=30 的响应
curl -s -X POST localhost:8080/admin/entries \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "status": 200,
    "responseHeaders": {
      "cache-control": "max-age=60, stale-while-revalidate=30",
      "etag": "\"v1\""
    },
    "body": "{\"v\":1}",
    "storedAt": '$T0'
  }'

# 2) t+5s：fresh，直接服务
curl -s -X POST localhost:8080/cache/request \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "virtualTime": '$((T0+5000))'
  }'

# 3) t+75s：处于 SWR 窗口，旧响应照常返回，同时签发回源令牌
curl -s -X POST localhost:8080/cache/request \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/feed",
    "virtualTime": '$((T0+75000))'
  }'
```

第 3 步响应的关键字段：

```json
{
  "state": "stale-while-revalidate",
  "action": "served-stale-and-revalidate",
  "servedStale": true,
  "response": { "status": 200, "headers": { "age": "75", "warning": "110 http-cache-lab \"Response is stale\"" }, "body": "{\"v\":1}" },
  "token": {
    "token": "TWW1WGYUPd…",
    "leader": true,
    "conditionalRequest": { "if-none-match": "\"v1\"" },
    "submitEndpoint": "POST /cache/revalidate"
  },
  "numbers": { "ageMs": 75000, "lifetimeMs": 60000, "swrMs": 30000, "freshnessMs": -15000 },
  "trail": [ /* 逐步解释，见下文 */ ]
}
```

领队拿着令牌去「回源」并提交结果：

```bash
curl -s -X POST localhost:8080/cache/revalidate \
  -H 'content-type: application/json' -d '{
    "token": "TWW1WGYUPd…",
    "status": 200,
    "headers": { "cache-control": "max-age=60, stale-while-revalidate=30", "etag": "\"v2\"" },
    "body": "{\"v\":2}",
    "originTime": '$((T0+75000))'
  }'
```

或者模拟源站确认未修改（304，自动合并响应头、沿用旧 body）：

```bash
curl -s -X POST localhost:8080/cache/revalidate \
  -H 'content-type: application/json' -d '{
    "token": "TWW1WGYUPd…", "status": 304,
    "headers": { "cache-control": "max-age=120", "etag": "\"v2\"" },
    "originTime": '$((T0+75000))'
  }'
```

---

## 端到端示例：条件失效一个 Vary 变体

假设有源站在推送配置后要求缓存**只作废 gzip 的 v1 变体**，且必须确认作废的确实是 v1（防止回源已写入 v2 后误删）：

```bash
T0=1767225600000

# 1) 预置同 URL 的两个 Vary 变体（ETag 不同）
curl -s -X POST localhost:8080/admin/entries -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "requestHeaders": { "accept-encoding": "gzip" },
  "responseHeaders": { "cache-control": "max-age=3600", "etag": "\"v1\"", "vary": "Accept-Encoding" },
  "body": "cfg-gzip-v1", "storedAt": '$T0'
}' >/dev/null
curl -s -X POST localhost:8080/admin/entries -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "requestHeaders": { "accept-encoding": "br" },
  "responseHeaders": { "cache-control": "max-age=3600", "etag": "\"v1\"", "vary": "Accept-Encoding" },
  "body": "cfg-br-v1", "storedAt": '$T0'
}' >/dev/null

# 2) 旧副本过期，领队已拿到 pending 回源令牌（失效时应一并释放）
curl -s -X POST localhost:8080/cache/request -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "gzip" },
  "virtualTime": '$((T0+9999000))'
}' >/dev/null

# 3) dryRun 预览：wouldAffectKeys 只有 gzip 变体；br 在 skipped(variant-miss)
curl -s -X POST localhost:8080/admin/invalidate -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "gzip" },
  "expectedEtag": "\"v1\"", "dryRun": true
}'

# 4) 错误的 ETag 守卫：什么都不删（etag-mismatch）
curl -s -X POST localhost:8080/admin/invalidate -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "gzip" },
  "expectedEtag": "\"v9\""
}'

# 5) 正式执行：删除 gzip v1 条目，并释放该键 pending 回源令牌
curl -s -X POST localhost:8080/admin/invalidate -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "gzip" },
  "expectedEtag": "\"v1\""
}'
# {"recordId":3,"dryRun":false,"affectedKeys":["<sha256>"],
#  "deleted":[{"cacheKey":"…","etag":"\"v1\""}],
#  "releasedTokens":[{"token":"…","cacheKey":"…",...}], ...}

# 6) 验证：gzip 已 miss（可重新回源），br 兄弟变体仍 fresh
curl -s -X POST localhost:8080/cache/request -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "gzip" }, "virtualTime": '$T0'
}' | grep -o '"state":"[a-z-]*"'
# "state":"miss"
curl -s -X POST localhost:8080/cache/request -H 'content-type: application/json' -d '{
  "url": "https://api.example.test/cfg",
  "headers": { "accept-encoding": "br" }, "virtualTime": '$T0'
}' | grep -o '"state":"[a-z-]*"'
# "state":"fresh"

# 7) 追溯：dryRun 预览与正式执行都在记录里
curl -s 'localhost:8080/admin/invalidations?limit=10'
```

---

## 缓存模型

### 虚拟时间

所有判定都使用请求显式携带的时间，与墙上时钟无关：

- body 字段 `virtualTime` / `storedAt` / `originTime`：整数毫秒或任何 `Date.parse` 能解析的字符串（ISO、HTTP 日期均可）；
- 也可用请求头 `X-Virtual-Time` 代替 body 字段。

`Age = max(0, virtualTime − storedAt)`，全程毫秒计算，输出 `Age` 头时向下取整。

### 缓存键

对以下材料逐行拼接后取 **SHA-256**，完整材料会随 `cacheKeyDetails.keyMaterial` 返回，可自行复核：

```
METHOD:<大写方法>
URL:<规范化 URL>
VARY:<逗号连接的小写 Vary 字段名>
H:<字段名>:<请求值，缺失为 ∅>
…
END
```

URL 规范化规则：scheme/host 小写、去除默认端口、路径 percent-encoding 归一、query 解析为 `(name,value)` 后字典序重排、丢弃 fragment。`/a` 与 `/a/` 视为不同资源。

Vary 变体查找：先按「方法 + 规范化 URL」筛候选条目，再用候选响应自己的 `Vary` 字段结合本次请求头算键精确匹配——这与真实缓存「响应头决定键」的行为一致。`Vary: *` 不可枚举，预置时直接拒绝（400）。

### 状态机

| state | 含义 | 是否返回响应 | 令牌 |
| --- | --- | --- | --- |
| `fresh` | `age + min-fresh ≤ lifetime` | ✅ 缓存响应 | 无 |
| `stale-while-revalidate` | 落在 `lifetime ~ lifetime+swr` 窗口 | ✅ 旧响应（带 `Warning: 110`） | ✅ 领队/加入 |
| `stale` | 陈旧但被请求显式接受（`max-stale`、`only-if-cached`） | ✅ 旧响应 | 通常无 |
| `expired` | 过期且不可陈旧服务 | ❌ | ✅ 同步回源 |
| `miss` | 无缓存条目 | ❌ | ✅ 回源 |
| `bypass` | 请求 `no-store` / 非 GET·HEAD 方法 | ❌ | ✅ 回源（不读缓存） |
| `gateway-timeout` | `only-if-cached` 且无可用副本 | ❌（504 语义） | 无 |

新鲜寿命优先级：`s-maxage` > `max-age` > `Expires - storedAt` > 启发式 `10% × (storedAt - Last-Modified)` > `0`。

强制再验证开关：响应 `no-cache`、`must-revalidate`、`proxy-revalidate`，以及请求 `max-age` 被 Age 超过时，**禁止任何陈旧服务**（SWR 也不行）。请求侧还支持 `min-fresh`、`max-stale[=Δ]`、`only-if-cached`、`no-store`。响应侧另解析 `stale-if-error`（仅记录，因本服务不自动回源）。

### 单飞回源令牌

当判定需要回源时，服务在一个 SQLite `IMMEDIATE` 事务内：

1. 查该缓存键是否已有 `pending` 令牌；
2. **没有** → 生成 32 字节随机令牌，当前请求为 **leader**：
   - SWR：`action=served-stale-and-revalidate`（旧响应 + 令牌）；
   - miss/expired：`action=must-revalidate`（无响应，客户端必须提交回源结果）；
3. **已有** → 当前请求为加入者：
   - SWR：`action=served-stale-joining-revalidation`（旧响应 + 同一个令牌）；
   - miss/expired：`action=waiting`（**等待状态**，无响应、不重复回源）。

令牌行同时记录 method / 规范化 URL / Vary / 旧 ETag；响应里附 `conditionalRequest`（如 `If-None-Match`）供演练条件请求。

提交回源结果（`POST /cache/revalidate`）：

- 令牌不存在 → **404**；
- 令牌已结束且提交内容的指纹与首次相同 → **200 + `idempotentReplay: true`**（幂等重放）；
- 令牌已结束但内容不同 → **409**（拒绝覆盖）；
- 令牌 pending → 原子地写入新响应并把令牌置为 `consumed`；
- 提交 `status: 304` → 按 RFC 9111 合并：新响应头逐头覆盖旧头，body 与状态码沿用旧响应，`storedAt` 更新为 `originTime`；
- 回源响应的 `Vary` 集合与缓存键不一致 → **409**（演练要求变体结构稳定）。

等待方在领队提交后，**重新发起** `/cache/request`（带新的虚拟时间）即可看到新响应。若领队放弃回源，调用 `POST /cache/tokens/:token/release` 释放令牌，同键才能签发新令牌。

### 解释轨迹（trail）

每次 `/cache/request` 的响应都包含 `trail: [{step, detail, data?}]`，按执行顺序覆盖：

`request` → `normalize` → `variants?` → `key` → `lookup` → `request-cache-control?` → `response-cache-control?` → `no-store?` → `age` → `lifetime` → `min-fresh?` / `max-stale?` / `no-cache?` / `must-revalidate?` → `freshness` → `stale-while-revalidate?` / `max-stale-serve?` / `expired` → `token?`

每步都给出人话解释与可核对的数值（`numbers`）。所有判定同时落库到 `decision_logs`，可通过 `GET /cache/decisions` 回看。

---

## API 参考

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/cache/request` | 携带虚拟时间发起缓存请求（核心端点） |
| `POST` | `/cache/revalidate` | 凭令牌提交回源结果（幂等） |
| `POST` | `/cache/tokens/:token/release` | 放弃 pending 令牌 |
| `GET` | `/cache/tokens?all=0` | 令牌列表（默认仅 pending） |
| `GET` | `/cache/entries?limit=100` | 预置/回源后的缓存条目 |
| `GET` | `/cache/decisions?limit=100` | 历史判定（含完整 trail） |
| `GET` | `/cache/stats` | entries / pendingTokens / decisions 计数 |
| `POST` | `/admin/entries` | 预置模拟响应 |
| `DELETE` | `/admin/entries/:cacheKey` | 删除单个条目 |
| `POST` | `/admin/invalidate` | 条件失效（Vary 精确解析 + ETag 守卫 + dryRun） |
| `GET` | `/admin/invalidations?limit=100` | 失效操作记录（含 dryRun 预览记录） |
| `POST` | `/admin/reset` | 清空全部数据并轮换实例 ID |
| `GET` | `/healthz` | 健康检查 |

### `POST /cache/request`

```json
{
  "method": "GET",
  "url": "https://api.example.test/a?b=2&a=1#frag",
  "headers": { "accept-encoding": "gzip", "cache-control": "max-stale=10" },
  "virtualTime": "2026-01-01T00:01:15Z",
  "requestId": "my-trace-id"
}
```

- `method` 默认 `GET`；仅 `GET`/`HEAD` 读取缓存（其余方法走 `bypass`）。
- 头名大小写不敏感；数组值按 `, ` 合并。
- `HEAD` 命中时抑制 body（`bodySuppressedForHead: true`）。
- `requestId` 缺省时自动生成，便于串联并发组。

### `POST /admin/entries`

```json
{
  "method": "GET",
  "url": "https://api.example.test/v",
  "requestHeaders": { "accept-encoding": "br" },
  "status": 200,
  "responseHeaders": { "cache-control": "max-age=60", "vary": "Accept-Encoding" },
  "body": "...",
  "storedAt": 1767225600000
}
```

便捷字段（可选，会并入响应头）：`cacheControl`、`etag`（自动补引号）、`vary`。
`date` / `expires` / `last-modified` 接受 ISO 字符串，入库时统一为 IMF-fixdate；缺省 `Date` 自动补为 `storedAt`。
同一缓存键重复预置即为覆盖（保留 `createdAt`，刷新 `updatedAt`）。

### `POST /cache/revalidate`

```json
{
  "token": "…",
  "status": 200,
  "headers": { "cache-control": "max-age=60" },
  "body": "…",
  "originTime": 1767225675000
}
```

`responseHeaders` 与 `headers` 二者皆可（后者优先）；`body` 为字符串或 `null`。

### `POST /admin/invalidate`

按「方法 + 规范化 URL + 请求头」**精确解析 Vary 变体**后做条件失效。变体解析规则与 `/cache/request` 完全一致：先按方法 + 规范化 URL 取候选，再用候选**响应自身的 `Vary`** 结合本次 `headers` 计算缓存键——因此只会失效请求头真正选中的那个变体，同 URL 的兄弟变体不动。

```json
{
  "method": "GET",
  "url": "https://api.example.test/v?z=1&a=2",
  "headers": { "accept-encoding": "gzip" },
  "expectedEtag": "\"v1\"",
  "dryRun": false,
  "requestId": "my-invalidation-id"
}
```

- `method` 默认 `GET`；`HEAD` 与 `/cache/request` 一样映射到 `GET` 键空间（响应中以 `keyMethod` 体现）。
- `headers`：参与 Vary 选择的请求头（头名大小写不敏感，规则同缓存请求）。
- `expectedEtag`：**条件守卫，可省略**。给出时仅删除条目当前 ETag 与之**精确相等**的键；裸值（`v1`）自动补引号（`"v1"`），带 `W/` 前缀则原样使用。省略表示不按 ETag 限制。
- `dryRun: true`：只做解析与预览，**不删除、不放令牌**；预览同样写入失效记录（`dryRun: true`），便于审计「谁在什么时候预览过什么」。

执行（非 dryRun）在**单个 SQLite `IMMEDIATE` 事务**内完成：

1. 对每个变体命中的目标键再次读取条目，仅当 ETag 与 `expectedEtag` 相符才 `DELETE`（计划与执行之间条目被回源覆盖时不会误删新内容）；
2. 每删除一个键，**释放该键的 pending 回源令牌**（置 `released`），之后该键的请求可以重新签发令牌；非 pending（consumed/released）令牌不动；
3. 写入 `invalidation_logs` 记录。

响应字段：

| 字段 | 含义 |
| --- | --- |
| `recordId` | 失效记录 ID，可用 `GET /admin/invalidations` 回看 |
| `targets` / `matchedKeys` | Vary 变体命中的目标键（含键材料选择值、实际 ETag） |
| `affectedKeys` / `deleted` | **实际**删除的键与 ETag（dryRun 恒为空数组） |
| `releasedTokens` | **实际**释放的 pending 令牌（dryRun 恒为空） |
| `wouldAffectKeys` / `wouldReleaseTokens` | 仅 dryRun：执行时将删除/将释放的预览 |
| `skipped` | 逐个候选/目标键的跳过明细（含 Vary 选择值、期望/实际 ETag） |
| `skipSummary` | 按跳过原因聚合计数 |

跳过原因（`skipped[].reason`）：

- `no-candidate`：方法 + 规范化 URL 下没有任何条目；
- `variant-miss`：同 URL 存在其他 Vary 变体，但按本次请求头算出的键不匹配（**不属于被失效的变体**，原样保留）；
- `etag-mismatch`：变体命中，但条目当前 ETag 与 `expectedEtag` 不符（计划阶段或事务内复核发现，均跳过）；
- `entry-vanished`：计划后、事务执行前条目已被并发移除。

示例（dryRun 预览 → 确认后执行）：

```bash
# 1) 预览：只会失效 gzip 变体，br 变体出现在 skipped(variant-miss)
curl -s -X POST localhost:8080/admin/invalidate \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/v",
    "headers": { "accept-encoding": "gzip" },
    "expectedEtag": "\"v1\"",
    "dryRun": true
  }'

# 2) 确认无误后去掉 dryRun 正式执行
curl -s -X POST localhost:8080/admin/invalidate \
  -H 'content-type: application/json' -d '{
    "url": "https://api.example.test/v",
    "headers": { "accept-encoding": "gzip" },
    "expectedEtag": "\"v1\""
  }'

# 3) 回看全部失效记录（含 dryRun）
curl -s 'localhost:8080/admin/invalidations?limit=20'
```

---

## 演练剧本建议

1. **新鲜度三态**：同一预置条目，用 `t+30s / t+75s / t+200s` 三个虚拟时间请求，观察 `fresh → SWR → expired`。
2. **并发单飞**：expired 状态下并发 5 个请求，确认只有 1 个 `must-revalidate`、其余 `waiting` 且共享同一令牌；领队提交后其余请求重放命中新响应。
3. **幂等与防覆盖**：用同一令牌提交两次相同内容（第二次 `idempotentReplay=true`），再改一个字节提交（409）。
4. **304 合并**：预置 `no-cache` + ETag 条目 → 拿到带 `If-None-Match` 的令牌 → 提交 304 与新 `max-age` → 验证 body 沿用、寿命更新。
5. **Vary 变体**：预置同一 URL 的 `gzip` / `br` 两个变体，换请求头观察键材料与命中差异。
6. **URL 规范化**：用乱序 query、大小写 host、默认端口、fragment 等形式请求同一资源，对比 `normalizedUrl` 与 `cacheKey`。
7. **条件失效**：预置 `gzip` / `br` 两个 ETag 不同的变体 → 先 `dryRun` 确认只选中 gzip 且 br 出现在 `variant-miss` → 用错误的 `expectedEtag` 执行被 `etag-mismatch` 拦下 → 用正确 ETag 执行后确认 gzip 删除、br 仍命中、pending 令牌被释放。

---

## 设计说明与边界

- **单进程 SQLite**：回源单飞依赖 `better-sqlite3` 的同步事务（`BEGIN IMMEDIATE`）。多副本部署时每个实例各自单飞；本项目定位为单机演练工具。
- **不主动发起真实回源**：服务只模拟缓存层，「源站响应」由客户端通过令牌提交，时间线完全可控、可重放。
- **等待不阻塞连接**：`waiting` 是立即返回的状态对象而非长轮询，方便在脚本/测试中显式编排并发组。
- **Vary 结构稳定**：回源响应不得改变 `Vary` 字段集合（返回 409）；真实缓存中这等价于换键，需要重新填充。
- **不模拟的部分**：请求折叠时的 `Pragma`、`stale-if-error` 的自动 5xx 回退（仅轨迹提示）、共享/私有缓存授权语义（`private` 被解析但不拦截存储，便于自由演练）。

## 项目结构

```
src/
  index.ts          Fastify 启动与错误处理
  routes.ts         HTTP 端点与单飞编排
  freshness.ts      纯函数：新鲜度判定与轨迹生成
  canonical.ts      URL 规范化、Vary 解析、缓存键计算
  cache-control.ts  Cache-Control 指令解析（请求/响应共用）
  http-date.ts      IMF-fixdate / RFC850 / asctime 解析与格式化
  db.ts             SQLite 表、条目写入、原子令牌签发与提交、条件失效事务
  util.ts           时间/头/指纹等工具
scripts/smoke.ts    端到端断言（84 项）
```
