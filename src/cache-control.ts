import { CacheControlDirectives, ParseCacheControlResult } from './types';

/**
 * 解析 Cache-Control 头（请求/响应共用）。
 *
 * 规则：
 * - 指令大小写不敏感，token 形式视为 true（如 no-store）
 * - delta-seconds 指令取整数秒，非法负值按 0 处理（RFC 9111 1.2.1）
 * - max-stale 不带值 => true（语义为「任意陈旧都可接受」）
 * - no-cache / private 可带字段名列表（="a, b"），解析为数组
 * - 未识别指令原样收集到 extensions，不报错
 */
export function parseCacheControl(headerValue: string | undefined): ParseCacheControlResult {
  const directives: CacheControlDirectives = {};
  const warnings: string[] = [];
  const extensions: string[] = [];

  if (!headerValue || headerValue.trim() === '') {
    return { directives, warnings };
  }
  directives.raw = headerValue;

  const fieldTokens = new Set(['no-cache', 'private']);
  const deltaTokens = new Set([
    'max-age',
    's-maxage',
    'stale-while-revalidate',
    'stale-if-error',
    'min-fresh',
  ]);

  for (const rawPart of splitDirectives(headerValue)) {
    const part = rawPart.trim();
    if (part === '') continue;
    const eq = part.indexOf('=');
    let name: string;
    let value: string | undefined;
    if (eq === -1) {
      name = part.toLowerCase();
    } else {
      name = part.slice(0, eq).trim().toLowerCase();
      value = unquote(part.slice(eq + 1).trim());
    }
    if (name === '') continue;

    if (name === 'max-stale') {
      if (value === undefined) {
        directives['max-stale'] = true;
      } else {
        directives['max-stale'] = parseDelta(name, value, warnings);
      }
    } else if (deltaTokens.has(name)) {
      if (value === undefined) {
        warnings.push(`${name} 缺少 delta-seconds 值，已忽略`);
      } else {
        assignDirective(directives, name, parseDelta(name, value, warnings));
      }
    } else if (fieldTokens.has(name)) {
      if (value === undefined) {
        assignDirective(directives, name, true);
      } else {
        assignDirective(
          directives,
          name,
          value
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        );
      }
    } else if (
      [
        'no-store',
        'must-revalidate',
        'proxy-revalidate',
        'public',
        'immutable',
        'no-transform',
        'only-if-cached',
      ].includes(name)
    ) {
      // token 形式指令：即使带值也按存在性处理
      assignDirective(directives, name, true);
      if (value !== undefined) warnings.push(`${name} 不应带值，已按存在性处理`);
    } else {
      extensions.push(name + (value !== undefined ? `=${value}` : ''));
    }
  }

  if (extensions.length > 0) directives.extensions = extensions;
  return { directives, warnings };
}

/** 按逗号切分指令（引号内逗号不切） */
function splitDirectives(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const ch of value) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1');
  }
  return value;
}

function parseDelta(name: string, value: string, warnings: string[]): number {
  if (!/^\d+$/.test(value)) {
    warnings.push(`${name}=${value} 不是合法的 delta-seconds，按 0 处理`);
    return 0;
  }
  return Number(value);
}

function assignDirective(
  directives: CacheControlDirectives,
  name: string,
  value: boolean | number | string[]
): void {
  (directives as Record<string, unknown>)[name] = value;
}
