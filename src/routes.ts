import { FastifyInstance } from 'fastify';
import {
  CacheStore,
  InvalidationSkip,
  InvalidationTarget,
  RevalidationConflictError,
} from './db';
import {
  computeCacheKey,
  normalizeUrl,
  parseVary,
  selectVaryHeaders,
} from './canonical';
import { evaluateFreshness, FreshnessResult } from './freshness';
import { formatHttpDate, parseHttpDate } from './http-date';
import { EntryRow, HeaderMap, TrailStep } from './types';
import {
  generateRequestId,
  normalizeHeaders,
  parseVirtualTime,
  sha256,
  stableStringify,
  ValidationError,
} from './util';

interface CacheRequestPayload {
  method?: string;
  url?: string;
  headers?: unknown;
  virtualTime?: unknown;
  requestId?: unknown;
}

interface StoreEntryPayload {
  method?: unknown;
  url?: unknown;
  requestHeaders?: unknown;
  headers?: unknown;
  responseHeaders?: unknown;
  status?: unknown;
  body?: unknown;
  storedAt?: unknown;
  cacheControl?: unknown;
  etag?: unknown;
  vary?: unknown;
}

interface InvalidatePayload {
  method?: unknown;
  url?: unknown;
  /** 参与 Vary 变体选择的请求头 */
  headers?: unknown;
  /** 条件守卫：仅失效 ETag 相符的变体；缺省表示不按 ETag 限制 */
  expectedEtag?: unknown;
  dryRun?: unknown;
  requestId?: unknown;
}

export default function registerRoutes(app: FastifyInstance, store: CacheStore): void {
  // —— 基础信息 ——
  app.get('/', async () => ({
    service: 'http-cache-lab',
    description: 'HTTP 缓存策略演练 API（虚拟时间 / 解释轨迹 / 回源单飞令牌）',
    port: 8080,
    instanceId: store.getInstanceId(),
    endpoints: {
      'POST /cache/request': '携带虚拟时间发起一次缓存请求',
      'POST /cache/revalidate': '凭回源令牌提交源站结果（幂等）',
      'POST /cache/tokens/:token/release': '放弃令牌',
      'GET  /cache/tokens': '查看令牌（?all=1 含已结束）',
      'GET  /cache/entries': '查看缓存条目',
      'GET  /cache/decisions': '查看判定轨迹日志',
      'GET  /cache/stats': '计数',
      'POST /admin/entries': '预置模拟响应',
      'DELETE /admin/entries/:cacheKey': '删除单个条目',
      'POST /admin/invalidate': '按方法+URL+请求头解析 Vary 变体并条件失效（支持 dryRun）',
      'GET  /admin/invalidations': '失效操作记录（含 dryRun 预览）',
      'POST /admin/reset': '清空所有数据并重置实例',
      'GET  /healthz': '健康检查',
    },
  }));

  app.get('/healthz', async () => ({ ok: true, stats: store.stats() }));

  // —— 核心：虚拟时间缓存请求 ——
  app.post('/cache/request', async (req, reply) => {
    const body = (req.body ?? {}) as CacheRequestPayload;
    const requestId = asOptionalString(body.requestId, 'requestId') ?? generateRequestId();

    const method = (asOptionalString(body.method, 'method') ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new ValidationError('method 必须是 HTTP 方法 token');
    // RFC 9110：HEAD 与 GET 共享缓存存储——HEAD 请求按 GET 的键查找，返回时抑制 body
    const keyMethod = method === 'HEAD' ? 'GET' : method;

    const url = asRequiredString(body.url, 'url');
    const normalized = normalizeUrl(url);

    const requestHeaders = normalizeHeaders(body.headers);
    const virtualTime = readVirtualTime(body.virtualTime, req.headers['x-virtual-time']);

    // 完整缓存键需要响应自身的 Vary 字段，因此先按「方法 + 规范化 URL」
    // 找候选变体，再结合请求头精确匹配。
    const lookup = lookupEntry(store, keyMethod, normalized.normalized, requestHeaders);

    const trail: TrailStep[] = [];
    trail.push({
      step: 'request',
      detail: `受理请求 ${method} ${url}，虚拟时间 ${virtualTime}（${formatHttpDate(virtualTime)}）`,
      data: { requestId, method, keyMethod, url, virtualTime, headerNames: Object.keys(requestHeaders) },
    });
    if (method !== keyMethod) {
      trail.push({
        step: 'method-mapping',
        detail: `${method} 请求复用 ${keyMethod} 的缓存存储（键方法按 ${keyMethod} 计算），命中后不返回 body`,
      });
    }
    trail.push({
      step: 'normalize',
      detail: `规范化 URL => ${normalized.normalized}（query 按 (name,value) 排序，去 fragment，小写 host）`,
      data: normalized,
    });
    if (lookup.candidates.length > 1) {
      trail.push({
        step: 'variants',
        detail: `同一规范化 URL 下存在 ${lookup.candidates.length} 个 Vary 变体，按请求头选择`,
        data: {
          candidates: lookup.candidates.map((c) => ({
            cacheKey: c.cache_key,
            vary: JSON.parse(c.vary_names),
          })),
        },
      });
    }
    trail.push(...lookup.trail);

    const freshness = evaluateFreshness({
      method,
      requestHeaders,
      virtualTime,
      entry: lookup.entry,
    });
    // 合并：把 freshness 自己的 lookup 前轨迹跳过（前面已记录），直接接其余步骤
    trail.push(...freshness.trail);

    // —— 依据状态编排回源单飞 ——
    const needsOrigin =
      freshness.state === 'miss' ||
      freshness.state === 'expired' ||
      freshness.state === 'bypass' ||
      freshness.state === 'stale-while-revalidate';

    let tokenInfo:
      | { token: string; leader: boolean; reason: string; status: string; etag: string | null }
      | undefined;

    let cacheKey: string | null = lookup.entry?.cache_key ?? lookup.key?.cacheKey ?? null;

    if (freshness.state === 'gateway-timeout') {
      const logId = logDecision(store, {
        requestId, virtualTime, method, url, freshness, trail,
        normalizedUrl: normalized.normalized,
        cacheKey: lookup.entry?.cache_key ?? lookup.key?.cacheKey ?? null,
        token: null,
        action: 'gateway-timeout',
      });
      return reply.code(200).send({
        requestId,
        decisionId: logId,
        state: 'gateway-timeout',
        action: 'gateway-timeout',
        cacheKey,
        virtualTime,
        response: {
          status: 504,
          headers: { 'content-type': 'application/json' },
          body: null,
        },
        servedStale: false,
        waiting: false,
        token: null,
        numbers: freshness.numbers,
        trail,
      });
    }

    if (needsOrigin) {
      // bypass（请求 no-store / 非缓存方法）没有稳定的条目键，用规范化材料构造一个
      // 只用于「同一回源合并」的键：Vary 取自请求头列表中的预声明（不支持时为空）。
      const keyForRevalidation =
        lookup.entry?.cache_key ??
        lookup.key?.cacheKey ??
        computeCacheKey({
          method: keyMethod,
          normalizedUrl: normalized.normalized,
          varyNames: [],
          varySelectors: [],
        }).cacheKey;
      cacheKey = keyForRevalidation;

      const etag = lookup.entry
        ? (JSON.parse(lookup.entry.response_headers) as HeaderMap)['etag'] ?? null
        : null;

      const issued = store.issueToken({
        cacheKey: keyForRevalidation,
        reason: freshness.revalidateReason ?? freshness.state,
        requestId,
        virtualTime,
        etag,
        method: keyMethod,
        normalizedUrl: normalized.normalized,
        varyNames: lookup.entry
          ? (JSON.parse(lookup.entry.vary_names) as string[])
          : [],
      });
      tokenInfo = {
        token: issued.row.token,
        leader: issued.leader,
        reason: issued.row.reason,
        status: issued.row.status,
        etag: issued.row.etag,
      };
      trail.push({
        step: 'token',
        detail: issued.leader
          ? `本请求是该键并发组的领队：签发回源令牌 ${issued.row.token.slice(0, 16)}…，负责提交回源结果`
          : `该键已有 pending 回源令牌（由请求 ${issued.row.request_id} 持有）：本请求不重复回源，进入等待`,
        data: {
          leader: issued.leader,
          tokenPrefix: issued.row.token.slice(0, 16),
          holderRequestId: issued.row.request_id,
          reason: issued.row.reason,
          conditionalHeaders: issued.row.etag ? { 'if-none-match': issued.row.etag } : {},
        },
      });
    }

    // —— 组装响应 ——
    const canServe = freshness.canServe;
    let responsePayload: unknown = null;
    let servedStale = false;
    let warningHeader: string | undefined;

    if (canServe && lookup.entry) {
      const entry = lookup.entry;
      const respHeaders = { ...(JSON.parse(entry.response_headers) as HeaderMap) };
      respHeaders['age'] = String(Math.max(0, Math.floor(freshness.numbers.ageMs / 1000)));
      if (freshness.state === 'stale-while-revalidate' || freshness.state === 'stale') {
        servedStale = true;
        // RFC 5861 / RFC 7234 Warning 110：Response is stale
        warningHeader = '110 http-cache-lab "Response is stale"';
        respHeaders['warning'] = warningHeader;
        respHeaders['cache-control'] =
          (respHeaders['cache-control'] ? respHeaders['cache-control'] + ', ' : '') +
          (freshness.state === 'stale-while-revalidate'
            ? 'stale-while-revalidate'
            : 'max-stale');
      }
      responsePayload = {
        status: entry.status,
        headers: respHeaders,
        body: method === 'HEAD' ? null : entry.body,
        bodySuppressedForHead: method === 'HEAD',
        storedAt: entry.stored_at,
      };
    }

    const waiting = needsOrigin && !canServe && !!tokenInfo && !tokenInfo.leader;
    const mustRevalidate = needsOrigin && !canServe && !!tokenInfo && tokenInfo.leader;

    const action = !needsOrigin
      ? canServe
        ? 'served'
        : 'error'
      : canServe
        ? tokenInfo?.leader
          ? 'served-stale-and-revalidate'
          : 'served-stale-joining-revalidation'
        : tokenInfo?.leader
          ? 'must-revalidate'
          : 'waiting';

    const logId = logDecision(store, {
      requestId, virtualTime, method, url, freshness, trail,
      normalizedUrl: normalized.normalized, cacheKey, token: tokenInfo?.token ?? null,
      action,
    });

    return reply.code(200).send({
      requestId,
      decisionId: logId,
      state: freshness.state,
      action,
      cacheKey,
      virtualTime,
      ...(lookup.keyDetails
        ? {
            cacheKeyDetails: lookup.keyDetails,
          }
        : {}),
      response: responsePayload,
      servedStale,
      waiting,
      mustRevalidate,
      token: tokenInfo
        ? {
            token: tokenInfo.token,
            leader: tokenInfo.leader,
            holder: !tokenInfo.leader,
            status: tokenInfo.status,
            reason: tokenInfo.reason,
            /** 领队提交回源结果时应携带的条件请求头 */
            conditionalRequest: tokenInfo.etag
              ? { 'if-none-match': tokenInfo.etag }
              : {},
            submitEndpoint: 'POST /cache/revalidate',
          }
        : null,
      numbers: freshness.numbers,
      trail,
    });
  });

  // —— 提交回源结果（令牌校验 + 幂等）——
  app.post('/cache/revalidate', async (req, reply) => {
    const body = (req.body ?? {}) as {
      token?: unknown;
      status?: unknown;
      headers?: unknown;
      responseHeaders?: unknown;
      body?: unknown;
      originTime?: unknown;
      virtualTime?: unknown;
    };

    const token = asRequiredString(body.token, 'token');
    const tokenRow = store.getToken(token);
    if (!tokenRow) {
      throw new RevalidationHttpError(404, `令牌不存在: ${token.slice(0, 16)}…（可能已被 reset）`);
    }

    const status = body.status === undefined ? 200 : asStatus(body.status);
    const headers = normalizeHeaders(body.responseHeaders ?? body.headers);
    if (body.body !== undefined && typeof body.body !== 'string' && body.body !== null) {
      throw new ValidationError('body 必须是字符串或 null（二进制内容请自行编码后放入）');
    }
    const originTime = readVirtualTime(body.originTime ?? body.virtualTime, undefined, 'originTime');

    if (tokenRow.status !== 'pending') {
      const payloadHash = sha256(stableStringify({ status, headers, body: body.body ?? null }));
      if (tokenRow.payload_hash === payloadHash) {
        return reply.code(200).send({
          outcome: 'already_consumed',
          idempotentReplay: true,
          token: tokenRow.token,
          status: tokenRow.status,
          resultSummary: tokenRow.result_summary,
          entry: serializeEntry(store.getEntry(tokenRow.cache_key)),
          message: '相同回源结果重复提交，已按幂等处理',
        });
      }
      throw new RevalidationHttpError(
        409,
        `令牌已 ${tokenRow.status}，且本次内容与首次提交不同（payload 指纹不一致），拒绝覆盖`
      );
    }

    let result;
    try {
      result = store.applyRevalidation(
        token,
        { status, headers, body: (body.body ?? null) as string | null, originTime },
        Date.now()
      );
    } catch (err) {
      if (err instanceof RevalidationConflictError) {
        throw new RevalidationHttpError(409, err.message);
      }
      throw err;
    }

    if (result.conflict) {
      throw new RevalidationHttpError(409, result.conflict);
    }

    return reply.code(200).send({
      outcome: result.outcome,
      idempotentReplay: false,
      token,
      cacheKey: tokenRow.cache_key,
      entry: serializeEntry(result.entry),
      message:
        result.outcome === 'not_modified_merged'
          ? '源站返回 304：已将新响应头合并到旧条目，body 与状态码沿用旧响应，storedAt 更新为 originTime'
          : '缓存已用回源响应替换；等待中的并发请求现在可以重新发起判定',
    });
  });

  // —— 令牌管理 ——
  app.post('/cache/tokens/:token/release', async (req, reply) => {
    const token = (req.params as { token: string }).token;
    const outcome = store.releaseToken(token, Date.now());
    if (outcome === 'not_found') throw new RevalidationHttpError(404, '令牌不存在');
    return reply.code(200).send({
      outcome,
      token,
      message:
        outcome === 'released'
          ? '令牌已放弃，同键后续请求将签发新的回源令牌'
          : '令牌已结束（consumed），无需释放',
    });
  });

  app.get('/cache/tokens', async (req) => {
    const q = req.query as { all?: string; limit?: string };
    const limit = clampLimit(q.limit);
    return {
      tokens: store.listTokens(q.all === '1' || q.all === 'true', limit),
    };
  });

  app.get('/cache/entries', async (req) => {
    const q = req.query as { limit?: string };
    return { entries: store.listEntries(clampLimit(q.limit)).map(serializeEntry) };
  });

  app.get('/cache/decisions', async (req) => {
    const q = req.query as { limit?: string };
    return { decisions: store.listDecisionLogs(clampLimit(q.limit)) };
  });

  app.get('/cache/stats', async () => store.stats());

  // —— 管理：预置模拟响应 ——
  app.post('/admin/entries', async (req, reply) => {
    const body = (req.body ?? {}) as StoreEntryPayload;
    const method = (asOptionalString(body.method, 'method') ?? 'GET').toUpperCase();
    const url = asRequiredString(body.url, 'url');
    const normalized = normalizeUrl(url);
    const requestHeaders = normalizeHeaders(body.requestHeaders);

    const status = body.status === undefined ? 200 : asStatus(body.status);
    const responseHeaders = normalizeHeaders(body.responseHeaders ?? body.headers);

    // 便捷字段：cacheControl / etag / vary 自动并入响应头
    const cc = asOptionalString(body.cacheControl, 'cacheControl');
    if (cc !== undefined) responseHeaders['cache-control'] = cc;
    const etag = asOptionalString(body.etag, 'etag');
    if (etag !== undefined) {
      responseHeaders['etag'] = etag.startsWith('"') || etag.startsWith('W/') ? etag : `"${etag}"`;
    }
    const vary = asOptionalString(body.vary, 'vary');
    if (vary !== undefined) responseHeaders['vary'] = vary;

    // storedAt 必须显式给出（预置的核心就是「存入时间」）
    const storedAt = readVirtualTime(body.storedAt, undefined, 'storedAt');

    // 日期类头允许 ISO 字符串预置，统一输出 IMF-fixdate
    for (const dateHeader of ['date', 'expires', 'last-modified']) {
      if (responseHeaders[dateHeader] !== undefined) {
        responseHeaders[dateHeader] = normalizeDateHeader(
          dateHeader,
          responseHeaders[dateHeader]
        );
      }
    }

    const varyParsed = parseVary(responseHeaders['vary']);
    if (varyParsed.wildcard) {
      // Vary: * 无法构造可复用键：允许存入，但标记不可匹配
      throw new ValidationError('Vary: * 表示键不可枚举，无法用于可核对的缓存演练；请显式列出 Vary 字段');
    }
    const selectors = selectVaryHeaders(varyParsed.names, requestHeaders);
    const keyDetails = computeCacheKey({
      method,
      normalizedUrl: normalized.normalized,
      varyNames: varyParsed.names,
      varySelectors: selectors,
    });

    if (responseHeaders['date'] === undefined) {
      responseHeaders['date'] = formatHttpDate(storedAt);
    }

    const entry = store.putEntry(
      {
        method,
        normalizedUrl: normalized.normalized,
        varyNames: varyParsed.names,
        varySelectors: selectors,
        cacheKey: keyDetails.cacheKey,
        requestHeaders,
        status,
        responseHeaders,
        body: body.body === undefined ? null : String(body.body),
        storedAt,
      },
      Date.now()
    );

    return reply.code(201).send({
      stored: true,
      cacheKeyDetails: keyDetails,
      entry: serializeEntry(entry),
    });
  });

  app.delete('/admin/entries/:cacheKey', async (_req, reply) => {
    const cacheKey = (_req.params as { cacheKey: string }).cacheKey;
    const existed = store.deleteEntry(cacheKey);
    if (!existed) throw new RevalidationHttpError(404, `条目不存在: ${cacheKey}`);
    return reply.code(200).send({ deleted: true, cacheKey });
  });

  // —— 条件失效（按方法 + URL + 请求头精确解析 Vary 变体）——
  app.post('/admin/invalidate', async (req, reply) => {
    const body = (req.body ?? {}) as InvalidatePayload;

    const method = (asOptionalString(body.method, 'method') ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new ValidationError('method 必须是 HTTP 方法 token');
    // 与 /cache/request 一致：HEAD 与 GET 共享缓存键空间
    const keyMethod = method === 'HEAD' ? 'GET' : method;

    const url = asRequiredString(body.url, 'url');
    const normalized = normalizeUrl(url);
    const requestHeaders = normalizeHeaders(body.headers);
    const requestId =
      asOptionalString(body.requestId, 'requestId') ?? generateRequestId();
    const dryRun = body.dryRun === undefined ? false : asBoolean(body.dryRun, 'dryRun');

    // 条件守卫：expectedEtag 缺省时不按 ETag 限制
    let expectedEtag: string | null = null;
    const rawEtag = asOptionalString(body.expectedEtag, 'expectedEtag');
    if (rawEtag !== undefined) {
      expectedEtag =
        rawEtag.startsWith('"') || rawEtag.startsWith('W/') ? rawEtag : `"${rawEtag}"`;
    }

    // 与 lookupEntry 相同的「响应头决定键」解析：先按方法+规范化 URL 取候选，
    // 再用每个候选自身的 Vary 集合结合本次请求头精确计算键。
    const candidates = store
      .listEntries(500)
      .filter((e) => e.method === keyMethod && e.normalized_url === normalized.normalized);

    const targets: InvalidationTarget[] = [];
    const skipped: InvalidationSkip[] = [];
    const candidateDetails: Array<{
      cacheKey: string;
      vary: string[];
      requestedKey: string;
      match: boolean;
      etag: string | null;
    }> = [];

    for (const candidate of candidates) {
      const varyNames = JSON.parse(candidate.vary_names) as string[];
      const varySelectors = selectVaryHeaders(varyNames, requestHeaders);
      const keyDetails = computeCacheKey({
        method: keyMethod,
        normalizedUrl: normalized.normalized,
        varyNames,
        varySelectors,
      });
      const actualEtag = (JSON.parse(candidate.response_headers) as HeaderMap)['etag'] ?? null;
      const match = keyDetails.cacheKey === candidate.cache_key;
      candidateDetails.push({
        cacheKey: candidate.cache_key,
        vary: varyNames,
        requestedKey: keyDetails.cacheKey,
        match,
        etag: actualEtag,
      });

      if (!match) {
        skipped.push({
          reason: 'variant-miss',
          detail: `候选条目 Vary(${varyNames.join(',') || '∅'}) 的选择值与本次请求头不一致，不属于被失效的变体`,
          normalizedUrl: normalized.normalized,
          method: keyMethod,
          candidateCacheKey: candidate.cache_key,
          requestedKey: keyDetails.cacheKey,
          varyNames,
          varySelectors,
        });
        continue;
      }

      // 事务内会再做一次 ETag 复核；这里先按计划快照给出跳过项，便于解释
      if (expectedEtag !== null && actualEtag !== expectedEtag) {
        skipped.push({
          reason: 'etag-mismatch',
          detail: `变体命中但 ETag 不符：条目当前为 ${actualEtag ?? '∅'}，期望 ${expectedEtag}，按条件守卫跳过`,
          normalizedUrl: normalized.normalized,
          method: keyMethod,
          cacheKey: candidate.cache_key,
          varyNames,
          varySelectors,
          expectedEtag,
          actualEtag,
        });
        continue;
      }

      targets.push({
        cacheKey: candidate.cache_key,
        method: keyMethod,
        normalizedUrl: normalized.normalized,
        varyNames,
        varySelectors,
        expectedEtag,
        actualEtag,
      });
    }

    if (candidates.length === 0) {
      skipped.push({
        reason: 'no-candidate',
        detail: `方法 ${keyMethod} + 规范化 URL ${normalized.normalized} 下没有任何缓存条目`,
        normalizedUrl: normalized.normalized,
        method: keyMethod,
      });
    }

    const result = store.invalidate({
      requestId,
      dryRun,
      method,
      keyMethod,
      url,
      normalizedUrl: normalized.normalized,
      expectedEtag,
      targets,
      skipped,
      now: Date.now(),
    });

    return reply.code(dryRun ? 200 : 201).send({
      recordId: result.id,
      requestId: result.requestId,
      dryRun,
      method,
      keyMethod,
      url,
      normalizedUrl: normalized.normalized,
      expectedEtag,
      requestHeaders,
      candidates: candidateDetails,
      targets: result.targets,
      matchedKeys: result.targets.map((t) => t.cacheKey),
      // 实际影响：dryRun 恒为空（不产生副作用）
      affectedKeys: result.affectedKeys,
      deleted: result.deleted,
      releasedTokens: result.releasedTokens,
      // dryRun 预览：执行时将发生的动作
      ...(dryRun
        ? {
            wouldAffectKeys: result.wouldAffectKeys,
            wouldReleaseTokens: result.wouldReleaseTokens,
          }
        : {}),
      skipped: result.skipped,
      skipSummary: summarizeSkips(result.skipped),
      stats: store.stats(),
      recordsEndpoint: 'GET /admin/invalidations',
      message: dryRun
        ? `dryRun 预览：将删除 ${result.wouldAffectKeys.length} 个条目、释放 ${result.wouldReleaseTokens.length} 个 pending 令牌；未做任何修改（预览已留痕 #${result.id}）`
        : `已删除 ${result.deleted.length} 个条目、释放 ${result.releasedTokens.length} 个 pending 回源令牌；失效记录 #${result.id}`,
    });
  });

  app.get('/admin/invalidations', async (req) => {
    const q = req.query as { limit?: string };
    return { invalidations: store.listInvalidationLogs(clampLimit(q.limit)) };
  });

  // —— 重置 ——
  app.post('/admin/reset', async () => {
    store.reset();
    return {
      reset: true,
      instanceId: store.getInstanceId(),
      stats: store.stats(),
      message: '已清空 entries / tokens / decision_logs，并轮换实例 ID',
    };
  });
}

// —— helpers ——

interface LookupResult {
  entry: EntryRow | undefined;
  candidates: EntryRow[];
  trail: TrailStep[];
  key: { cacheKey: string } | undefined;
  keyDetails: unknown;
}

/**
 * 变体查找：
 * 1. 先在 entries 中找「方法 + 规范化 URL」相同的候选（表小，直接全扫；
 *    键本身是哈希，无法反推，故用这两列过滤）
 * 2. 用候选条目响应中的 Vary 字段，结合本次请求头算变体键，精确匹配
 * 3. 没有任何候选时，用空 Vary 造一个 miss 键，保证 miss 也有可核对的键
 */
function lookupEntry(
  store: CacheStore,
  method: string,
  normalizedUrl: string,
  requestHeaders: HeaderMap
): LookupResult {
  const trail: TrailStep[] = [];
  const candidates = store
    .listEntries(500)
    .filter((e) => e.method === method && e.normalized_url === normalizedUrl);

  if (candidates.length === 0) {
    const keyDetails = computeCacheKey({
      method,
      normalizedUrl,
      varyNames: [],
      varySelectors: [],
    });
    trail.push({
      step: 'key',
      detail: '无候选变体，按空 Vary 计算 miss 键',
      data: keyDetails,
    });
    return { entry: undefined, candidates, trail, key: keyDetails, keyDetails };
  }

  for (const candidate of candidates) {
    const varyNames = JSON.parse(candidate.vary_names) as string[];
    const selectors = selectVaryHeaders(varyNames, requestHeaders);
    const keyDetails = computeCacheKey({
      method,
      normalizedUrl,
      varyNames,
      varySelectors: selectors,
    });
    if (keyDetails.cacheKey === candidate.cache_key) {
      trail.push({
        step: 'key',
        detail: `按方法+规范化URL+Vary(${varyNames.join(',') || '∅'}) 计算缓存键并命中变体`,
        data: keyDetails,
      });
      return { entry: candidate, candidates, trail, key: keyDetails, keyDetails };
    }
  }

  // URL 相同但所有 Vary 变体都不匹配 —— 按第一个候选的 Vary 结构给出「最近的未命中键」
  const first = candidates[0]!;
  const varyNames = JSON.parse(first.vary_names) as string[];
  const selectors = selectVaryHeaders(varyNames, requestHeaders);
  const keyDetails = computeCacheKey({ method, normalizedUrl, varyNames, varySelectors: selectors });
  trail.push({
    step: 'key',
    detail: `URL 下有变体但 Vary 选择值不匹配；按 Vary(${varyNames.join(',') || '∅'}) 计算键，未命中`,
    data: keyDetails,
  });
  return { entry: undefined, candidates, trail, key: keyDetails, keyDetails };
}

function logDecision(
  store: CacheStore,
  p: {
    requestId: string;
    virtualTime: number;
    method: string;
    url: string;
    freshness: FreshnessResult;
    trail: TrailStep[];
    normalizedUrl: string;
    cacheKey: string | null;
    token: string | null;
    action: string;
  }
): number {
  return store.insertDecisionLog({
    requestId: p.requestId,
    virtualTime: p.virtualTime,
    method: p.method,
    url: p.url,
    normalizedUrl: p.normalizedUrl,
    cacheKey: p.cacheKey,
    state: p.freshness.state,
    action: p.action,
    token: p.token,
    trail: p.trail,
    now: Date.now(),
  });
}

function serializeEntry(entry: EntryRow | undefined): unknown {
  if (!entry) return null;
  return {
    cacheKey: entry.cache_key,
    method: entry.method,
    normalizedUrl: entry.normalized_url,
    vary: JSON.parse(entry.vary_names),
    varySelectors: JSON.parse(entry.vary_selectors_json),
    requestHeaders: JSON.parse(entry.request_headers),
    status: entry.status,
    responseHeaders: JSON.parse(entry.response_headers),
    body: entry.body,
    storedAt: entry.stored_at,
    createdAt: entry.created_at,
    updatedAt: entry.updated_at,
  };
}

function readVirtualTime(
  bodyValue: unknown,
  headerValue: string | string[] | undefined,
  field = 'virtualTime'
): number {
  if (bodyValue !== undefined && bodyValue !== null) {
    return parseVirtualTime(bodyValue, field);
  }
  if (headerValue !== undefined) {
    const v = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    return parseVirtualTime(v, `X-Virtual-Time/${field}`);
  }
  throw new ValidationError(`${field} 缺失：请在 body 中提供，或使用 X-Virtual-Time 头`);
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} 必须是非空字符串`);
  }
  return value;
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ValidationError(`${field} 必须是字符串`);
  return value;
}

function asBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} 必须是布尔值`);
  return value;
}

/** 按原因聚合计数跳过项，便于一眼看出各变体被跳过的原因 */
function summarizeSkips(skipped: InvalidationSkip[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const s of skipped) {
    summary[s.reason] = (summary[s.reason] ?? 0) + 1;
  }
  return summary;
}

function asStatus(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value >= 600) {
    throw new ValidationError('status 必须是 100-599 的整数');
  }
  return value;
}

function clampLimit(value: string | undefined): number {
  const n = Number(value ?? 100);
  if (!Number.isFinite(n) || n <= 0) return 100;
  return Math.min(1000, Math.floor(n));
}

class RevalidationHttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'RevalidationHttpError';
    this.statusCode = statusCode;
  }
}

/** 预置时宽松接受 ISO/毫秒形式的日期头，输出标准 IMF-fixdate */
function normalizeDateHeader(name: string, raw: string): string {
  let ms = parseHttpDate(raw);
  if (ms === null) ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    throw new ValidationError(`${name} 不是合法的 HTTP 日期: ${raw}`);
  }
  return formatHttpDate(ms);
}
