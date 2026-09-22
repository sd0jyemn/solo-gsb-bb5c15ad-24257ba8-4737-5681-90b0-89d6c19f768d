/**
 * HTTP 日期与时间相关辅助（RFC 9110 5.6.7 的 IMF-fixdate 等三种历史格式）。
 */

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** 输出 IMF-fixdate，如 Sun, 06 Nov 1994 08:49:37 GMT */
export function formatHttpDate(epochMs: number): string {
  const d = new Date(epochMs);
  const day = DAY[d.getUTCDay()];
  const date = String(d.getUTCDate()).padStart(2, '0');
  const mon = MONTH[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${day}, ${date} ${mon} ${year} ${hh}:${mm}:${ss} GMT`;
}

/**
 * 宽松解析 HTTP 日期，支持：
 * - IMF-fixdate: Sun, 06 Nov 1994 08:49:37 GMT
 * - RFC 850:    Sunday, 06-Nov-94 08:49:37 GMT
 * - asctime:    Sun Nov  6 08:49:37 1994
 * 失败返回 null。
 */
export function parseHttpDate(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  // IMF-fixdate
  let m = trimmed.match(
    /^(?:\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/
  );
  if (m) return fromParts(m[3]!, m[2]!, m[1]!, m[4]!, m[5]!, m[6]!);

  // RFC 850（两位年份按 19xx/20xx 处理）
  m = trimmed.match(
    /^(?:\w+), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/
  );
  if (m) {
    const yy = Number(m[3]);
    const year = yy >= 69 ? 1900 + yy : 2000 + yy;
    return fromParts(String(year), m[2]!, m[1]!, m[4]!, m[5]!, m[6]!);
  }

  // asctime
  m = trimmed.match(/^(\w{3}) (\w{3}) [ ](\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/);
  if (m) return fromParts(m[7]!, m[2]!, m[3]!, m[4]!, m[5]!, m[6]!);

  return null;
}

function fromParts(
  year: string,
  monName: string,
  day: string,
  hh: string,
  mm: string,
  ss: string
): number | null {
  const mon = MONTH.indexOf(monName);
  if (mon === -1) return null;
  const ms = Date.UTC(
    Number(year),
    mon,
    Number(day),
    Number(hh),
    Number(mm),
    Number(ss)
  );
  return Number.isNaN(ms) ? null : ms;
}
