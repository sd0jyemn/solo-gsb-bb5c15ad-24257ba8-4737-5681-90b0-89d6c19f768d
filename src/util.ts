import { createHash, randomBytes } from 'crypto';
import { HeaderMap } from './types';

/** SHA-256 十六进制摘要 */
export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 生成回源令牌（32 字节随机，URL 安全） */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** 生成请求 ID（未显式提供时） */
export function generateRequestId(): string {
  return 'req_' + randomBytes(8).toString('hex');
}

/**
 * 把任意头对象规范化为「头名小写 -> 字符串值」。
 * - 头名 trim 后小写
 * - 数组值按 RFC 字段合并规则以 ", " 连接
 * - null/undefined 值被忽略
 */
export function normalizeHeaders(input: unknown): HeaderMap {
  const out: HeaderMap = {};
  if (input == null) return out;
  if (typeof input !== 'object') {
    throw new ValidationError('headers 必须是对象');
  }
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = String(rawName).trim().toLowerCase();
    if (!name) continue;
    if (rawValue === null || rawValue === undefined) continue;
    const value = Array.isArray(rawValue)
      ? rawValue.map((v) => String(v)).join(', ')
      : String(rawValue);
    if (out[name] !== undefined) {
      out[name] = out[name] + ', ' + value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

/** 大小写不敏感地读取头 */
export function getHeader(headers: HeaderMap, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

/**
 * 解析虚拟时间：数字视为 epoch 毫秒；字符串走 Date.parse。
 * 非法输入抛 ValidationError。
 */
export function parseVirtualTime(value: unknown, field = 'virtualTime'): number {
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  throw new ValidationError(`${field} 必须是整数毫秒时间戳或可被 Date.parse 解析的时间字符串`);
}

/** 毫秒转秒（向下取整），用于 Age 头 */
export function msToSecondsFloor(ms: number): number {
  return Math.max(0, Math.floor(ms / 1000));
}

/** 400 级别的可预期错误 */
export class ValidationError extends Error {
  statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** 确定性 JSON 序列化（键排序），用于幂等载荷指纹 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
