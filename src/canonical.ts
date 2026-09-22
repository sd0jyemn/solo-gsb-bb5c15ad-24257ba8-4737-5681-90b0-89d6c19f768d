import { sha256 } from './util';
import { HeaderMap, NormalizedUrl, CacheKeyDetails } from './types';

/**
 * 规范化 URL（缓存键用）：
 * 1. 必须是绝对 http/https URL
 * 2. scheme、host 小写；去掉默认端口
 * 3. 路径做 percent-encoding 归一（decode 后按安全字符集重新编码）、`.`/`..` 折叠由 URL 完成
 * 4. 查询串解析为 name/value 列表后按 (name, value) 字典序排序
 * 5. 丢弃 fragment
 * 6. 不补全结尾斜杠（/a 与 /a/ 是不同资源）
 */
export function normalizeUrl(rawUrl: string): NormalizedUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new NormalizeError(`无法解析 URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NormalizeError(`仅支持 http/https URL，收到: ${url.protocol}`);
  }

  const scheme = url.protocol.slice(0, -1);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') throw new NormalizeError('URL 缺少 host');

  const expectedPort = url.port && !isDefaultPort(scheme, url.port) ? ':' + url.port : '';

  const pathname = normalizePathname(url.pathname);
  const query: Array<{ name: string; value: string }> = [];
  for (const [name, value] of url.searchParams) {
    query.push({ name, value });
  }
  query.sort((a, b) => {
    if (a.name === b.name) return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
    return a.name < b.name ? -1 : 1;
  });
  const search = query.length === 0 ? '' : '?' + encodeQuery(query);

  const normalized = `${scheme}://${host}${expectedPort}${pathname}${search}`;

  return {
    normalized,
    scheme,
    host,
    port: url.port,
    pathname,
    search,
    query,
  };
}

function isDefaultPort(scheme: string, port: string): boolean {
  return (scheme === 'http' && port === '80') || (scheme === 'https' && port === '443');
}

/** decode 后按统一字符集重新 percent-encode，消除 %2f 与 %2F 之类的差异 */
function normalizePathname(pathname: string): string {
  // URL 已保证 pathname 以 / 开头
  return pathname
    .split('/')
    .map((segment) => {
      if (segment === '') return '';
      const decoded = safeDecodeURIComponent(segment);
      return encodeURIComponent(decoded).replace(/[!'()*]/g, (c) =>
        '%' + c.charCodeAt(0).toString(16).toUpperCase()
      );
    })
    .join('/');
}

function safeDecodeURIComponent(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment; // 非法转义序列保留原样
  }
}

/** 按排序后的查询重建查询串（encodeURIComponent 与 URLSearchParams 对齐） */
function encodeQuery(query: Array<{ name: string; value: string }>): string {
  return query
    .map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}

export class NormalizeError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'NormalizeError';
  }
}

/**
 * 解析 Vary 响应头：
 * - 头名 trim、小写、去重保序
 * - "*" 单独存在 => 返回 { wildcard: true }
 */
export function parseVary(value: string | undefined): {
  wildcard: boolean;
  names: string[];
} {
  if (!value) return { wildcard: false, names: [] };
  const tokens = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.includes('*')) return { wildcard: true, names: [] };
  const names: string[] = [];
  for (const name of tokens) {
    if (!names.includes(name)) names.push(name);
  }
  return { wildcard: false, names };
}

/**
 * 按 Vary 头名从请求头里挑出选择值。
 * 缺失的头用 null 表示（区分「无头」与「空值头」）。
 */
export function selectVaryHeaders(
  varyNames: string[],
  requestHeaders: HeaderMap
): Array<{ name: string; value: string | null }> {
  return varyNames.map((name) => ({
    name,
    value: requestHeaders[name] !== undefined ? requestHeaders[name] : null,
  }));
}

/**
 * 计算缓存键。
 *
 * 键材料（逐行）：
 *   METHOD:<大写方法>
 *   URL:<规范化 URL>
 *   VARY:<逗号连接的小写 Vary 字段名，保持响应头中出现顺序>
 *   H:<字段名>:<字段值或 "∅">   —— 每个 Vary 字段一行
 *   END
 *
 * 对该材料取 SHA-256。不同 Vary 集合（哪怕选择值相同）键也不同；
 * Vary: * 的条目不参与键匹配（调用方需先短路）。
 */
export function computeCacheKey(input: {
  method: string;
  normalizedUrl: string;
  varyNames: string[];
  varySelectors: Array<{ name: string; value: string | null }>;
}): CacheKeyDetails {
  const method = input.method.toUpperCase();
  const lines = [`METHOD:${method}`, `URL:${input.normalizedUrl}`, `VARY:${input.varyNames.join(',')}`];
  for (const selector of input.varySelectors) {
    lines.push(`H:${selector.name}:${selector.value === null ? '∅' : selector.value}`);
  }
  lines.push('END');
  const keyMaterial = lines.join('\n');
  return {
    method,
    normalizedUrl: input.normalizedUrl,
    varyNames: input.varyNames,
    varySelectors: input.varySelectors,
    keyMaterial,
    cacheKey: sha256(keyMaterial),
  };
}
