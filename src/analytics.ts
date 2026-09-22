/**
 * 按虚拟时间桶聚合 decision_logs 的纯计算模块。
 *
 * - 桶为左闭右开半开区间 [bucketStart, bucketStart + bucketMs)；
 *   最后一个桶同样半开，虚拟时间 == virtualTo 的日志不计入。
 * - p95 采用最近邻排名（nearest-rank，CEILING 排名法），无 Age 样本的桶为 null。
 * - 单飞领队率 = leaders / singleFlight；没有任何需回源请求的桶为 null。
 */
import type { CacheState } from './freshness';

/** 参与聚合的判定日志行（仅取需要的列，trail 不解析） */
export interface AnalyticsDecisionRow {
  virtual_time: number;
  state: string;
  action: string;
}

/** 需要统计的七种状态，顺序即输出字段顺序 */
export const ANALYTICS_STATES = [
  'fresh',
  'stale-while-revalidate',
  'stale',
  'expired',
  'miss',
  'bypass',
  'gateway-timeout',
] as const;

/** 拿到回源令牌、成为单飞并发组领队的动作 */
const LEADER_ACTIONS = new Set(['must-revalidate', 'served-stale-and-revalidate']);

/** 进入单飞编排的全部动作（领队 + 加入等待/陈旧服务的后来者） */
const SINGLE_FLIGHT_ACTIONS = new Set([
  ...LEADER_ACTIONS,
  'waiting',
  'served-stale-joining-revalidation',
]);

export interface AnalyticsBucket {
  /** 桶起点（虚拟时间，毫秒） */
  bucketStart: number;
  /** 桶终点（不含，毫秒） */
  bucketEnd: number;
  /** 落入本桶的判定日志数 */
  count: number;
  fresh: number;
  'stale-while-revalidate': number;
  stale: number;
  expired: number;
  miss: number;
  bypass: number;
  'gateway-timeout': number;
  /** 有 Age 的判定数（命中缓存条目的请求）；为 0 时 p95 为 null */
  ageSamples: number;
  /** 每桶 Age 的 p95（毫秒，最近邻排名）；无样本为 null */
  ageP95Ms: number | null;
  /** 每桶 Age 的 p95（秒，按 Age 头规则向下取整）；无样本为 null */
  ageP95Seconds: number | null;
  /** 成为单飞领队的请求数 */
  singleFlightLeaders: number;
  /** 参与单飞编排的请求数（领队 + 加入者） */
  singleFlight: number;
  /** 单飞领队率 leaders/singleFlight；singleFlight=0 时为 null */
  singleFlightLeaderRate: number | null;
}

/**
 * 把日志按虚拟时间落入半开时间桶并聚合。
 *
 * @param rows        已由存储层按 [virtualFrom, virtualTo) 与 URL 前缀过滤的日志
 * @param virtualFrom 区间起点（含）
 * @param virtualTo   区间终点（不含）
 * @param bucketMs    桶宽（毫秒）
 */
export function buildAnalyticsBuckets(
  rows: Array<AnalyticsDecisionRow & { ageMs: number | null }>,
  virtualFrom: number,
  virtualTo: number,
  bucketMs: number
): AnalyticsBucket[] {
  const bucketCount = Math.ceil((virtualTo - virtualFrom) / bucketMs);
  const buckets: AnalyticsBucket[] = Array.from({ length: bucketCount }, (_, i) => {
    const bucketStart = virtualFrom + i * bucketMs;
    return {
      bucketStart,
      bucketEnd: Math.min(bucketStart + bucketMs, virtualTo),
      count: 0,
      fresh: 0,
      'stale-while-revalidate': 0,
      stale: 0,
      expired: 0,
      miss: 0,
      bypass: 0,
      'gateway-timeout': 0,
      ageSamples: 0,
      ageP95Ms: null,
      ageP95Seconds: null,
      singleFlightLeaders: 0,
      singleFlight: 0,
      singleFlightLeaderRate: null,
    };
  });

  const agesByBucket: number[][] = Array.from({ length: bucketCount }, () => []);

  for (const row of rows) {
    if (row.virtual_time < virtualFrom || row.virtual_time >= virtualTo) continue;
    const index = Math.floor((row.virtual_time - virtualFrom) / bucketMs);
    const bucket = buckets[Math.min(index, bucketCount - 1)]!;
    bucket.count++;
    if (ANALYTICS_STATES.includes(row.state as CacheState)) {
      bucket[row.state as CacheState]++;
    }
    if (row.ageMs !== null) {
      agesByBucket[index]!.push(row.ageMs);
      bucket.ageSamples++;
    }
    if (SINGLE_FLIGHT_ACTIONS.has(row.action)) {
      bucket.singleFlight++;
      if (LEADER_ACTIONS.has(row.action)) bucket.singleFlightLeaders++;
    }
  }

  for (let i = 0; i < bucketCount; i++) {
    const bucket = buckets[i]!;
    const ages = agesByBucket[i]!;
    if (ages.length > 0) {
      bucket.ageP95Ms = percentileNearestRank(ages, 95);
      bucket.ageP95Seconds = Math.floor(bucket.ageP95Ms / 1000);
    }
    if (bucket.singleFlight > 0) {
      // 保留 6 位小数，避免长循环小数影响核对
      bucket.singleFlightLeaderRate =
        Math.round((bucket.singleFlightLeaders / bucket.singleFlight) * 1e6) / 1e6;
    }
  }

  return buckets;
}

/**
 * 最近邻排名百分位（nearest-rank / CEILING 排名法）：
 * rank = ceil(p/100 × n)，取升序排列后第 rank 个值（1-based）。
 */
export function percentileNearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

/**
 * 从判定轨迹 JSON 中提取 Age（毫秒）。
 * 轨迹里 age 步骤由 freshness 判定写入；miss / bypass / gateway-timeout
 * 没有该步骤，返回 null（不参与 p95）。
 */
export function extractAgeMsFromTrail(trailJson: string): number | null {
  try {
    const trail = JSON.parse(trailJson) as Array<{
      step?: unknown;
      data?: { ageMs?: unknown };
    }>;
    if (!Array.isArray(trail)) return null;
    for (const step of trail) {
      if (
        step &&
        step.step === 'age' &&
        typeof step.data === 'object' &&
        step.data !== null &&
        typeof step.data.ageMs === 'number'
      ) {
        return step.data.ageMs;
      }
    }
  } catch {
    // 轨迹损坏不影响其余统计
  }
  return null;
}
