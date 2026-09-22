/**
 * /cache/analytics 的纯函数聚合：
 * 把 decision_logs 按「虚拟时间」落入半开时间桶，统计各判定状态数量、
 * 每桶 Age 的 p95（最近邻排名）与单飞领队率。
 *
 * 不读写数据库、不产生任何副作用——行数据由调用方传入。
 */

/** 与 freshness.ts 的 CacheState 保持一致的七种判定状态 */
export const ANALYTICS_STATES = [
  'fresh',
  'stale-while-revalidate',
  'stale',
  'expired',
  'miss',
  'bypass',
  'gateway-timeout',
] as const;

export type AnalyticsState = (typeof ANALYTICS_STATES)[number];

/** 七状态名（普通字符串数组，供遍历/断言使用） */
export const ANALYTICS_STATE_NAMES: readonly string[] = ANALYTICS_STATES;

export type StateCounts = Record<AnalyticsState, number>;

/** /cache/request 落库的一行判定（仅取分析所需列） */
export interface AnalyticsDecisionRow {
  id: number;
  virtual_time: number;
  state: string;
  trail_json: string;
}

export interface AnalyticsBucket {
  /** 桶起点（含），毫秒 */
  bucketStart: number;
  /** 桶终点（不含）；尾桶被 virtualTo 截断时等于 virtualTo */
  bucketEnd: number;
  /** 尾桶是否短于 bucketSeconds（区间长度非整数倍时） */
  partial: boolean;
  /** 落入该桶的判定总数 */
  total: number;
  /** 各判定状态数量（固定七键，缺失补 0） */
  counts: StateCounts;
  /** 参与 Age 统计的样本数（fresh/SWR/stale/expired 等真实命中副本的判定） */
  ageSamples: number;
  /** Age p95（毫秒，最近邻排名）；无 Age 样本为 null */
  ageP95Ms: number | null;
  /** Age p95（秒，向下取整）；无 Age 样本为 null */
  ageP95Seconds: number | null;
  /** 参与单飞编排的判定数（拿到令牌，含领队与加入/等待者） */
  singleFlight: number;
  /** 其中成为并发组领队的判定数 */
  leaders: number;
  /** 单飞领队率 = leaders / singleFlight；singleFlight=0 时为 null */
  leaderRate: number | null;
}

export interface AnalyticsSummary {
  /** 区间内参与聚合的判定总数 */
  total: number;
  /** 各判定状态在全区间的合计 */
  counts: StateCounts;
  /** 全区间 Age 样本数 */
  ageSamples: number;
  /** 全区间 Age p95（毫秒）；无样本为 null */
  ageP95Ms: number | null;
  ageP95Seconds: number | null;
  singleFlight: number;
  leaders: number;
  /** 全区间单飞领队率；singleFlight=0 时为 null */
  leaderRate: number | null;
}

export interface AnalyticsResult {
  virtualFrom: number;
  virtualTo: number;
  bucketSeconds: number;
  bucketMs: number;
  /** 规范化后的 URL 前缀（未给时为 null，匹配全部） */
  urlPrefix: string | null;
  /** 区间内、前缀命中的判定行数（聚合前） */
  matchedRows: number;
  buckets: AnalyticsBucket[];
  summary: AnalyticsSummary;
}

interface Accumulator {
  counts: StateCounts;
  ages: number[];
  singleFlight: number;
  leaders: number;
}

function emptyCounts(): StateCounts {
  return {
    fresh: 0,
    'stale-while-revalidate': 0,
    stale: 0,
    expired: 0,
    miss: 0,
    bypass: 0,
    'gateway-timeout': 0,
  };
}

function emptyAccumulator(): Accumulator {
  return { counts: emptyCounts(), ages: [], singleFlight: 0, leaders: 0 };
}

/**
 * 从判定轨迹中取出本判定的 Age（毫秒）。
 * 仅真实命中缓存副本的判定带有 `age` 步骤；miss / bypass / gateway-timeout
 * 没有 Age 概念，不参与 p95 样本。
 */
function extractAgeMs(trail: unknown): number | null {
  if (!Array.isArray(trail)) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const step = trail[i] as { step?: unknown; data?: unknown } | null;
    if (step && step.step === 'age') {
      const data = step.data as { ageMs?: unknown } | undefined;
      if (typeof data?.ageMs === 'number' && Number.isFinite(data.ageMs) && data.ageMs >= 0) {
        return data.ageMs;
      }
    }
  }
  return null;
}

/**
 * 从判定轨迹中取出本判定在单飞编排中的角色。
 * `token` 步骤的 data.leader 由令牌签发结果直接写入：true=领队，false=加入者。
 * 无 token 步骤（fresh / stale / gateway-timeout 等）返回 null。
 */
function extractLeader(trail: unknown): boolean | null {
  if (!Array.isArray(trail)) return null;
  for (let i = trail.length - 1; i >= 0; i--) {
    const step = trail[i] as { step?: unknown; data?: unknown } | null;
    if (step && step.step === 'token') {
      const data = step.data as { leader?: unknown } | undefined;
      return data?.leader === true;
    }
  }
  return null;
}

/**
 * p95（最近邻排名 / nearest-rank）：
 * 升序后取第 ceil(0.95 × n) 个样本（1-based）。空样本返回 null。
 */
export function percentile95(sortedAsc: number[]): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.ceil(0.95 * n);
  return sortedAsc[rank - 1]!;
}

function finalize(
  acc: Accumulator,
  total: number
): {
  total: number;
  counts: StateCounts;
  ageSamples: number;
  ageP95Ms: number | null;
  ageP95Seconds: number | null;
  singleFlight: number;
  leaders: number;
  leaderRate: number | null;
} {
  const sorted = [...acc.ages].sort((a, b) => a - b);
  const p95 = percentile95(sorted);
  return {
    total,
    counts: acc.counts,
    ageSamples: acc.ages.length,
    ageP95Ms: p95,
    ageP95Seconds: p95 === null ? null : Math.floor(p95 / 1000),
    singleFlight: acc.singleFlight,
    leaders: acc.leaders,
    leaderRate: acc.singleFlight === 0 ? null : acc.leaders / acc.singleFlight,
  };
}

/**
 * 按虚拟时间把判定行落入半开时间桶并聚合。
 *
 * 桶网格以 virtualFrom 为原点对齐：第 k 个桶为
 *   [virtualFrom + k·bucketMs, virtualFrom + (k+1)·bucketMs)
 * 查询区间是半开 [virtualFrom, virtualTo)；区间长度不是 bucketMs 整数倍时，
 * 尾桶按 virtualTo 截断并标记 partial。桶按起点升序输出（含空桶，空桶 p95 为 null）。
 */
export function buildAnalytics(params: {
  virtualFrom: number;
  virtualTo: number;
  bucketSeconds: number;
  urlPrefix: string | null;
  rows: AnalyticsDecisionRow[];
}): AnalyticsResult {
  const { virtualFrom, virtualTo, urlPrefix } = params;
  const bucketMs = params.bucketSeconds * 1000;
  const bucketCount = Math.ceil((virtualTo - virtualFrom) / bucketMs);

  const buckets: Accumulator[] = [];
  const totals: number[] = [];
  for (let k = 0; k < bucketCount; k++) {
    buckets.push(emptyAccumulator());
    totals.push(0);
  }
  const overall = emptyAccumulator();
  let matchedRows = 0;

  // rows 已按 (virtual_time, id) 稳定排序；桶聚合保持该顺序（p95 与排序无关，
  // 仅按起点输出保证整体稳定）。
  for (const row of params.rows) {
    if (row.virtual_time < virtualFrom || row.virtual_time >= virtualTo) continue;
    matchedRows++;

    const idx = Math.min(
      bucketCount - 1,
      Math.floor((row.virtual_time - virtualFrom) / bucketMs)
    );
    const acc = buckets[idx]!;
    totals[idx]!++;

    let trail: unknown;
    try {
      trail = JSON.parse(row.trail_json);
    } catch {
      trail = null;
    }

    if (Object.prototype.hasOwnProperty.call(acc.counts, row.state)) {
      acc.counts[row.state as AnalyticsState]++;
      overall.counts[row.state as AnalyticsState]++;
    }

    const ageMs = extractAgeMs(trail);
    if (ageMs !== null) {
      acc.ages.push(ageMs);
      overall.ages.push(ageMs);
    }

    const leader = extractLeader(trail);
    if (leader !== null) {
      acc.singleFlight++;
      overall.singleFlight++;
      if (leader) {
        acc.leaders++;
        overall.leaders++;
      }
    }
  }

  const outBuckets: AnalyticsBucket[] = buckets.map((acc, k) => {
    const bucketStart = virtualFrom + k * bucketMs;
    const rawEnd = bucketStart + bucketMs;
    const bucketEnd = Math.min(rawEnd, virtualTo);
    return {
      bucketStart,
      bucketEnd,
      partial: rawEnd > virtualTo,
      ...finalize(acc, totals[k]!),
    };
  });

  return {
    virtualFrom,
    virtualTo,
    bucketSeconds: params.bucketSeconds,
    bucketMs,
    urlPrefix,
    matchedRows,
    buckets: outBuckets,
    summary: finalize(overall, matchedRows),
  };
}
