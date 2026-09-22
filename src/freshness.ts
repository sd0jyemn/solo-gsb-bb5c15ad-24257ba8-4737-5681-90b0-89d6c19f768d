import { parseCacheControl } from './cache-control';
import { parseHttpDate } from './http-date';
import { normalizeHeaders } from './util';
import {
  CacheControlDirectives,
  EntryRow,
  HeaderMap,
  TrailStep,
} from './types';

export type CacheState =
  | 'fresh'
  | 'stale-while-revalidate'
  | 'stale'
  | 'expired'
  | 'miss'
  | 'bypass'
  | 'gateway-timeout';

export interface FreshnessInputs {
  method: string;
  requestHeaders: HeaderMap;
  virtualTime: number;
  entry: EntryRow | undefined;
}

export interface FreshnessResult {
  state: CacheState;
  trail: TrailStep[];
  /** 是否允许不回源直接把旧响应发给这个请求 */
  canServe: boolean;
  /** 旧响应的服务方式（用于解释） */
  serveReason?: string;
  /** 必须回源 / 必须等待的原因 */
  revalidateReason?: string;
  /** 判定所用的关键数值，方便核对 */
  numbers: {
    ageMs: number;
    lifetimeMs: number;
    swrMs: number;
    minFreshMs: number;
    maxStaleMs: number | null;
    freshnessMs: number;
  };
  responseCC: CacheControlDirectives;
  requestCC: CacheControlDirectives;
}

const CACHEABLE_METHODS = new Set(['GET', 'HEAD']);
const STALE_OVERRIDE_STATUS = new Set([500, 502, 503, 504]);

/**
 * 纯函数：给定缓存条目（可能不存在）与带虚拟时间的请求，产出状态与解释轨迹。
 * 不读写数据库、不签发令牌——令牌的单飞编排由调用方完成。
 */
export function evaluateFreshness(input: FreshnessInputs): FreshnessResult {
  const trail: TrailStep[] = [];
  const { requestHeaders, virtualTime, entry } = input;

  const { directives: requestCC, warnings: reqWarn } = parseCacheControl(
    requestHeaders['cache-control']
  );
  if (requestCC.raw !== undefined) {
    trail.push({
      step: 'request-cache-control',
      detail: `解析请求 Cache-Control: ${requestCC.raw}`,
      data: { directives: sanitizeCC(requestCC), warnings: reqWarn },
    });
  }

  const responseHeaders: HeaderMap = entry
    ? (JSON.parse(entry.response_headers) as HeaderMap)
    : {};
  const { directives: responseCC, warnings: resWarn } = parseCacheControl(
    responseHeaders['cache-control']
  );

  // —— 请求 no-store：完全绕过缓存 ——
  if (requestCC['no-store']) {
    trail.push({
      step: 'lookup',
      detail: entry
        ? `虽存在缓存条目（storedAt=${entry.stored_at}），但请求携带 no-store：不读取缓存`
        : '缓存中无条目，且请求携带 no-store：即使有副本也不得读取，必须回源',
      data: entry ? { cacheKey: entry.cache_key } : undefined,
    });
    trail.push({
      step: 'bypass',
      detail: '请求 no-store：缓存不得读取或复用任何存储响应，必须回源',
    });
    return result('bypass', trail, false, {
      revalidateReason: 'request-no-store',
      numbers: zero(),
      responseCC,
      requestCC,
    });
  }

  if (!CACHEABLE_METHODS.has(input.method)) {
    trail.push({
      step: 'lookup',
      detail: `${input.method} 不是默认可缓存方法（GET/HEAD），不读取缓存，直接回源`,
    });
    return result('bypass', trail, false, {
      revalidateReason: 'non-cacheable-method',
      numbers: zero(),
      responseCC,
      requestCC,
    });
  }

  // —— 未命中 ——
  if (!entry) {
    trail.push({
      step: 'lookup',
      detail: '缓存键未命中任何条目，需要回源',
    });
    if (requestCC['only-if-cached']) {
      trail.push({
        step: 'only-if-cached',
        detail: '请求要求 only-if-cached 且无缓存可用：返回 504，不回源',
      });
      return result('gateway-timeout', trail, false, {
        revalidateReason: 'only-if-cached-miss',
        numbers: zero(),
        responseCC,
        requestCC,
      });
    }
    return result('miss', trail, false, {
      revalidateReason: 'cache-miss',
      numbers: zero(),
      responseCC,
      requestCC,
    });
  }

  trail.push({
    step: 'lookup',
    detail: `命中缓存条目，存入时间 storedAt=${entry.stored_at}，状态码 ${entry.status}`,
    data: {
      cacheKey: entry.cache_key,
      storedAt: entry.stored_at,
      status: entry.status,
    },
  });

  if (responseCC.raw !== undefined) {
    trail.push({
      step: 'response-cache-control',
      detail: `解析已存响应的 Cache-Control: ${responseCC.raw}`,
      data: { directives: sanitizeCC(responseCC), warnings: resWarn },
    });
  }

  // —— 响应 no-store：理论上不该被存储，命中也视为无缓存 ——
  if (responseCC['no-store']) {
    trail.push({
      step: 'no-store',
      detail: '已存响应带 no-store（不应被缓存）：不复用，必须回源',
    });
    return result('bypass', trail, false, {
      revalidateReason: 'response-no-store',
      numbers: zero(),
      responseCC,
      requestCC,
    });
  }

  // —— Age ——
  const ageMs = Math.max(0, virtualTime - entry.stored_at);
  trail.push({
    step: 'age',
    detail: `Age = virtualTime(${virtualTime}) - storedAt(${entry.stored_at}) = ${ageMs} ms（负数钳为 0）`,
    data: { virtualTime, storedAt: entry.stored_at, ageMs, ageSeconds: Math.floor(ageMs / 1000) },
  });

  // —— Freshness lifetime ——
  const lifetime = computeLifetime(responseHeaders, responseCC, entry.stored_at, trail);
  const lifetimeMs = lifetime.lifetimeMs;

  // —— 请求侧窗口 ——
  const minFreshMs =
    requestCC['min-fresh'] !== undefined ? requestCC['min-fresh'] * 1000 : 0;
  const maxStaleMs =
    requestCC['max-stale'] === true
      ? Number.POSITIVE_INFINITY
      : requestCC['max-stale'] !== undefined
        ? requestCC['max-stale'] * 1000
        : null;

  const swrMs =
    responseCC['stale-while-revalidate'] !== undefined
      ? responseCC['stale-while-revalidate'] * 1000
      : 0;

  if (minFreshMs > 0) {
    trail.push({
      step: 'min-fresh',
      detail: `请求 min-fresh=${requestCC['min-fresh']}s：响应还须保持至少 ${minFreshMs} ms 的新鲜期`,
    });
  }
  if (maxStaleMs !== null) {
    trail.push({
      step: 'max-stale',
      detail:
        maxStaleMs === Number.POSITIVE_INFINITY
          ? '请求 max-stale 不带值：允许任意陈旧度的响应'
          : `请求 max-stale=${requestCC['max-stale']}s：容忍陈旧上限 ${maxStaleMs} ms`,
    });
  }

  // —— 硬再验证开关 ——
  // 响应 no-cache：使用前必须回源验证，任何陈旧服务窗口都不适用。
  const responseNoCache = responseCC['no-cache'] !== undefined;
  // 请求 max-age=0（及任意有限值小于当前 age）：要求回源，且不允许 SWR 静默服务。
  const requestMaxAge = requestCC['max-age'];
  const requestMaxAgeBreached =
    requestMaxAge !== undefined && ageMs > requestMaxAge * 1000;
  const prohibitStale =
    responseCC['must-revalidate'] ||
    responseCC['proxy-revalidate'] ||
    false;

  if (responseNoCache) {
    trail.push({
      step: 'no-cache',
      detail:
        '已存响应带 no-cache：每次使用前必须向源站验证；即便处于陈旧窗口也不得直接服务',
      data:
        responseCC['no-cache'] === true
          ? { scope: 'all' }
          : { scope: 'fields', fields: responseCC['no-cache'] },
    });
  }
  if (prohibitStale) {
    trail.push({
      step: 'must-revalidate',
      detail: `${
        responseCC['must-revalidate'] ? 'must-revalidate' : 'proxy-revalidate'
      }：陈旧后不得静默使用旧响应（SWR 被禁止），必须回源验证`,
    });
  }
  if (requestMaxAgeBreached) {
    trail.push({
      step: 'request-max-age',
      detail: `请求 max-age=${requestMaxAge}s 小于 Age=${Math.floor(ageMs / 1000)}s：本缓存副本不满足新鲜度要求`,
    });
  }

  const freshnessMs = lifetimeMs - ageMs;
  const freshEnough = ageMs + minFreshMs <= lifetimeMs;

  if (freshEnough && !responseNoCache && !requestMaxAgeBreached) {
    trail.push({
      step: 'freshness',
      detail: `判定 FRESH：lifetime=${lifetimeMs}ms，age=${ageMs}ms，剩余新鲜期=${freshnessMs}ms${
        minFreshMs > 0 ? `（满足 min-fresh 需剩余 ≥ ${minFreshMs}ms）` : ''
      }`,
      data: { lifetimeMs, ageMs, minFreshMs, freshnessMs },
    });
    return result('fresh', trail, true, {
      serveReason: 'fresh',
      numbers: { ageMs, lifetimeMs, swrMs, minFreshMs, maxStaleMs, freshnessMs },
      responseCC,
      requestCC,
    });
  }

  if (freshEnough === false) {
    trail.push({
      step: 'freshness',
      detail: `lifetime=${lifetimeMs}ms 已被 age=${ageMs}ms 超过${
        minFreshMs > 0 ? `（且需额外预留 min-fresh=${minFreshMs}ms）` : ''
      }：响应已陈旧`,
      data: { lifetimeMs, ageMs, minFreshMs, freshnessMs },
    });
  }

  // —— 以下为陈旧路径 ——

  // only-if-cached：陈旧但只要存在副本即可返回（不发起回源）
  if (requestCC['only-if-cached']) {
    trail.push({
      step: 'only-if-cached',
      detail: '请求 only-if-cached：接受已存的陈旧响应，不回源',
    });
    return result('stale', trail, true, {
      serveReason: 'only-if-cached',
      numbers: { ageMs, lifetimeMs, swrMs, minFreshMs, maxStaleMs, freshnessMs },
      responseCC,
      requestCC,
    });
  }

  // 1) stale-while-revalidate 窗口：可陈旧服务，同时必须回源
  const swrEligible =
    !responseNoCache &&
    !prohibitStale &&
    !requestMaxAgeBreached &&
    swrMs > 0 &&
    ageMs <= lifetimeMs + swrMs;

  if (swrEligible) {
    trail.push({
      step: 'stale-while-revalidate',
      detail: `Age=${ageMs}ms 落在 SWR 窗口内（lifetime=${lifetimeMs}ms + swr=${swrMs}ms，上界=${
        lifetimeMs + swrMs
      }ms）：可用旧响应服务，同时后台回源`,
      data: { windowStart: lifetimeMs, windowEnd: lifetimeMs + swrMs, ageMs },
    });
    return result('stale-while-revalidate', trail, true, {
      serveReason: 'stale-while-revalidate',
      revalidateReason: 'swr-window',
      numbers: { ageMs, lifetimeMs, swrMs, minFreshMs, maxStaleMs, freshnessMs },
      responseCC,
      requestCC,
    });
  }
  if (swrMs > 0 && ageMs > lifetimeMs + swrMs) {
    trail.push({
      step: 'stale-while-revalidate',
      detail: `Age=${ageMs}ms 已超出 SWR 窗口上界 ${lifetimeMs + swrMs}ms`,
    });
  }

  // 2) 请求显式容忍陈旧 max-stale：可服务，不需要回源
  if (
    !responseNoCache &&
    !prohibitStale &&
    maxStaleMs !== null &&
    ageMs <= lifetimeMs + maxStaleMs
  ) {
    trail.push({
      step: 'max-stale-serve',
      detail:
        maxStaleMs === Number.POSITIVE_INFINITY
          ? '请求 max-stale（无限）：直接服务陈旧响应，不回源'
          : `Age=${ageMs}ms 未超过 lifetime+max-stale=${
              lifetimeMs + maxStaleMs
            }ms：按请求容忍度服务陈旧响应，不回源`,
    });
    return result('stale', trail, true, {
      serveReason: 'max-stale',
      numbers: { ageMs, lifetimeMs, swrMs, minFreshMs, maxStaleMs, freshnessMs },
      responseCC,
      requestCC,
    });
  }

  // 3) 5xx 陈旧副本 + stale-if-error（仅当源站错误时才可用；演练里记录为不可自动服务）
  const sieMs =
    responseCC['stale-if-error'] !== undefined ? responseCC['stale-if-error'] * 1000 : 0;
  if (sieMs > 0) {
    trail.push({
      step: 'stale-if-error',
      detail:
        `响应带 stale-if-error=${responseCC['stale-if-error']}s：仅当回源得到 ` +
        `${[...STALE_OVERRIDE_STATUS].join('/')} 时才可服务（上限 ${sieMs}ms）；当前尚未回源，先回源`,
    });
  }

  // 4) 普通过期：必须同步回源
  const reasons: string[] = [];
  if (responseNoCache) reasons.push('response-no-cache');
  if (prohibitStale) reasons.push('must-revalidate/proxy-revalidate');
  if (requestMaxAgeBreached) reasons.push('request-max-age');
  if (maxStaleMs !== null) reasons.push('beyond-max-stale');
  if (!reasons.length) reasons.push('expired');
  trail.push({
    step: 'expired',
    detail: `副本已过期且没有可用的陈旧服务窗口：必须回源后才能响应（${reasons.join(', ')}）`,
  });
  return result('expired', trail, false, {
    revalidateReason: reasons.join('+'),
    numbers: { ageMs, lifetimeMs, swrMs, minFreshMs, maxStaleMs, freshnessMs },
    responseCC,
    requestCC,
  });
}

/**
 * 新鲜寿命（毫秒），优先级：
 *   s-maxage > max-age > Expires > 启发式（10% × (storedAt - Last-Modified)）> 0
 */
function computeLifetime(
  headers: HeaderMap,
  cc: CacheControlDirectives,
  storedAt: number,
  trail: TrailStep[]
): { lifetimeMs: number } {
  if (cc['s-maxage'] !== undefined) {
    const ms = cc['s-maxage'] * 1000;
    trail.push({
      step: 'lifetime',
      detail: `共享缓存采用 s-maxage=${cc['s-maxage']}s（优先于 max-age 与 Expires）=> ${ms}ms`,
      data: { source: 's-maxage', lifetimeMs: ms },
    });
    return { lifetimeMs: ms };
  }
  if (cc['max-age'] !== undefined) {
    const ms = cc['max-age'] * 1000;
    trail.push({
      step: 'lifetime',
      detail: `采用 Cache-Control: max-age=${cc['max-age']}s => lifetime=${ms}ms`,
      data: { source: 'max-age', lifetimeMs: ms },
    });
    return { lifetimeMs: ms };
  }
  if (cc.immutable) {
    trail.push({
      step: 'lifetime',
      detail: '响应带 immutable 但未给 max-age：immutable 不改变寿命，仅表示新鲜期内无需重新验证',
    });
  }
  const expires = parseHttpDate(headers['expires']);
  if (expires !== null) {
    const ms = Math.max(0, expires - storedAt);
    trail.push({
      step: 'lifetime',
      detail: `无 max-age，采用 Expires(${headers['expires']})：expires-storedAt=${expires}-${storedAt}=${ms}ms`,
      data: { source: 'expires', expiresAt: expires, lifetimeMs: ms },
    });
    return { lifetimeMs: ms };
  }
  const lastModified = parseHttpDate(headers['last-modified']);
  if (lastModified !== null && lastModified < storedAt) {
    const ms = Math.floor((storedAt - lastModified) * 0.1);
    trail.push({
      step: 'lifetime',
      detail:
        `既无 max-age 也无 Expires，采用启发式：10% × (storedAt(${storedAt}) - Last-Modified(${lastModified})) = ${ms}ms`,
      data: { source: 'heuristic-last-modified', lastModifiedAt: lastModified, lifetimeMs: ms },
    });
    return { lifetimeMs: ms };
  }
  trail.push({
    step: 'lifetime',
    detail: '没有任何显式新鲜期信息（max-age/s-maxage/Expires/Last-Modified）：寿命按 0 处理，存入即陈旧',
    data: { source: 'none', lifetimeMs: 0 },
  });
  return { lifetimeMs: 0 };
}

function result(
  state: CacheState,
  trail: TrailStep[],
  canServe: boolean,
  extra: Partial<FreshnessResult>
): FreshnessResult {
  return {
    state,
    trail,
    canServe,
    numbers: extra.numbers ?? zero(),
    responseCC: extra.responseCC ?? {},
    requestCC: extra.requestCC ?? {},
    ...extra,
  } as FreshnessResult;
}

function zero() {
  return {
    ageMs: 0,
    lifetimeMs: 0,
    swrMs: 0,
    minFreshMs: 0,
    maxStaleMs: null,
    freshnessMs: 0,
  };
}

/** 去掉 undefined 字段，让轨迹 JSON 更干净 */
function sanitizeCC(cc: CacheControlDirectives): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cc)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
