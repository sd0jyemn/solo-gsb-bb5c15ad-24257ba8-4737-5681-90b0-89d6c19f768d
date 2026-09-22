/* eslint-disable no-console */
/**
 * 端到端冒烟脚本：直接以 :memory: 启动服务，
 * 覆盖 fresh / SWR / expired / 单飞 / 幂等 / 304 / Vary / 重置等路径。
 * 用法：npm run smoke
 */
import { buildServer } from '../src/index';
import { FastifyInstance } from 'fastify';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}`, extra ?? '');
  }
}

async function call(
  app: FastifyInstance,
  method: 'POST' | 'GET' | 'DELETE',
  url: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const res = await app.inject({ method, url, payload: body as any, headers });
  return { status: res.statusCode, json: res.json() };
}

async function main(): Promise<void> {
  const app = buildServer(':memory:');

  const T0 = Date.parse('2026-01-01T00:00:00Z');
  const minute = 60_000;

  console.log('\n[1] 预置与 fresh 命中');
  let r = await call(app, 'POST', '/admin/entries', {
    method: 'GET',
    url: 'https://origin.test/a?b=2&a=1',
    status: 200,
    responseHeaders: { 'cache-control': 'max-age=60', etag: '"v1"' },
    body: 'hello',
    storedAt: T0,
  });
  check('预置返回 201', r.status === 201, r);
  const key = r.json.cacheKeyDetails.cacheKey;
  check('键材料包含方法/URL/Vary', r.json.cacheKeyDetails.keyMaterial.startsWith('METHOD:GET\nURL:https://origin.test/a?a=1&b=2'));

  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/a?a=1&b=2', // query 顺序不同
    virtualTime: T0 + 30 * 1000,
  });
  check('query 乱序仍命中', r.json.state === 'fresh' && r.json.action === 'served', {
    state: r.json.state,
    action: r.json.action,
  });
  check('返回旧响应体与 Age=30', r.json.response.body === 'hello' && r.json.response.headers.age === '30');
  check('fresh 时无令牌', r.json.token === null);

  console.log('\n[2] SWR 窗口：陈旧服务 + 领队令牌');
  r = await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/swr',
    responseHeaders: { 'cache-control': 'max-age=60, stale-while-revalidate=30' },
    body: 'swr-body',
    storedAt: T0,
  });
  check('预置 SWR 条目 201', r.status === 201);
  const swr1 = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/swr',
    virtualTime: T0 + 70 * 1000,
  });
  check('70s 时处于 stale-while-revalidate', swr1.json.state === 'stale-while-revalidate', swr1.json.state);
  check('旧响应被服务且 servedStale=true', swr1.json.response.body === 'swr-body' && swr1.json.servedStale === true);
  check('行动为 served-stale-and-revalidate', swr1.json.action === 'served-stale-and-revalidate');
  check('领队拿到 token', !!swr1.json.token?.leader && !!swr1.json.token.token);
  check('带 Warning 110', swr1.json.response.headers.warning?.startsWith('110'));

  console.log('\n[3] 并发单飞：同键只签发一个令牌，后来者等待');
  const burst = await Promise.all(
    [0, 1, 2, 3, 4].map((i) =>
      call(app, 'POST', '/cache/request', {
        url: 'https://origin.test/miss',
        virtualTime: T0 + i * minute,
        requestId: `burst-${i}`,
      })
    )
  );
  const leaders = burst.filter((b) => b.json.token?.leader === true);
  const waiters = burst.filter((b) => b.json.action === 'waiting');
  check('5 个并发 miss 只有 1 个领队', leaders.length === 1, leaders.map((l) => l.json.action));
  check('其余 4 个为 waiting', waiters.length === 4);
  check('等待者无 response、不重复回源', waiters.every((w) => w.json.response === null));
  const leaderToken = leaders[0].json.token.token;
  check('等待者都看到同一个令牌', waiters.every((w) => w.json.token.token === leaderToken));

  console.log('\n[4] 令牌校验与幂等提交');
  r = await call(app, 'POST', '/cache/revalidate', {
    token: 'not-a-real-token',
    status: 200,
    headers: { 'cache-control': 'max-age=60' },
    body: 'new',
    originTime: T0 + 5 * minute,
  });
  check('伪造令牌 404', r.status === 404);

  const payload = {
    token: leaderToken,
    status: 200,
    headers: { 'cache-control': 'max-age=60', etag: '"v2"' },
    body: 'new-body',
    originTime: T0 + 5 * minute,
  };
  r = await call(app, 'POST', '/cache/revalidate', payload);
  check('合法提交成功', r.status === 200 && r.json.outcome === 'updated');
  r = await call(app, 'POST', '/cache/revalidate', payload);
  check('相同内容重放 => 幂等', r.status === 200 && r.json.idempotentReplay === true);
  r = await call(app, 'POST', '/cache/revalidate', { ...payload, body: 'different' });
  check('不同内容 => 409', r.status === 409);

  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/miss',
    virtualTime: T0 + 5 * minute + 10 * 1000,
  });
  check('提交后再次判定为 fresh 新响应', r.json.state === 'fresh' && r.json.response.body === 'new-body');

  console.log('\n[5] 过期 + must-revalidate：同步等待，SWR 被禁');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/must',
    responseHeaders: { 'cache-control': 'max-age=60, stale-while-revalidate=300, must-revalidate' },
    body: 'strict',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/must',
    virtualTime: T0 + 90 * 1000,
  });
  check('must-revalidate 下过期 => expired/must-revalidate', r.json.state === 'expired');
  check('不服务陈旧响应', r.json.response === null && r.json.servedStale === false);
  check('行动 must-revalidate', r.json.action === 'must-revalidate');
  await call(app, 'POST', '/cache/tokens/' + r.json.token.token + '/release');

  console.log('\n[6] no-cache + 请求 max-stale 仍强制回源');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/nocache',
    responseHeaders: { 'cache-control': 'no-cache', etag: '"x"' },
    body: 'nc',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/nocache',
    virtualTime: T0 + 999 * minute,
    headers: { 'cache-control': 'max-stale=9999' },
  });
  check('no-cache 优先于 max-stale，需回源', r.json.state === 'expired' && r.json.action === 'must-revalidate');
  const ncToken = r.json.token.token;
  check('令牌携带 If-None-Match', r.json.token.conditionalRequest['if-none-match'] === '"x"');

  console.log('\n[7] 304 回源：合并头、沿用 body 与状态码');
  r = await call(app, 'POST', '/cache/revalidate', {
    token: ncToken,
    status: 304,
    headers: { 'cache-control': 'max-age=120', etag: '"x2"' },
    originTime: T0 + 999 * minute,
  });
  check('304 合并成功', r.status === 200 && r.json.outcome === 'not_modified_merged');
  check('body 沿用旧响应', r.json.entry.body === 'nc');
  check('新头覆盖旧头', r.json.entry.responseHeaders['cache-control'] === 'max-age=120');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/nocache',
    virtualTime: T0 + 999 * minute + 30 * 1000,
  });
  check('合并后 fresh', r.json.state === 'fresh');

  console.log('\n[8] Vary：同一 URL 按请求头区分缓存');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/v',
    requestHeaders: { 'accept-encoding': 'gzip' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding' },
    body: 'gzipped',
    storedAt: T0,
  });
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/v',
    requestHeaders: { 'accept-encoding': 'br' },
    responseHeaders: { 'cache-control': 'max-age=60', vary: 'Accept-Encoding' },
    body: 'brotli',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    method: 'HEAD',
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('HEAD 复用 GET 变体存储，命中且抑制 body', r.json.state === 'fresh' && r.json.response.body === null && r.json.response.bodySuppressedForHead === true);
  check('HEAD 轨迹含方法映射说明', r.json.trail.some((t: any) => t.step === 'method-mapping'));
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('gzip 变体命中', r.json.response.body === 'gzipped');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('br 变体命中', r.json.response.body === 'brotli');
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/v',
    headers: { 'accept-encoding': 'zstd' },
    virtualTime: T0,
  });
  check('未知变体 miss', r.json.state === 'miss');
  check('轨迹含 Vary 选择值', r.json.trail.some((t: any) => t.step === 'key'));

  console.log('\n[9] 请求侧指令：min-fresh / max-stale / only-if-cached / no-store');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/mf',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'mf',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/mf',
    headers: { 'cache-control': 'min-fresh=40' },
    virtualTime: T0 + 30 * 1000,
  });
  check('剩余 30s 不满足 min-fresh=40 => 必须回源', r.json.state === 'expired' && r.json.action === 'must-revalidate');
  const tok = r.json.token.token;
  await call(app, 'POST', '/cache/tokens/' + tok + '/release');

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/ms',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'ms',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/ms',
    headers: { 'cache-control': 'max-stale=600' },
    virtualTime: T0 + 120 * 1000,
  });
  check('max-stale 容忍陈旧直接服务、不回源', r.json.state === 'stale' && r.json.token === null && r.json.servedStale === true);

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/oic',
    responseHeaders: { 'cache-control': 'max-age=1' },
    body: 'oic',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/oic-missing',
    headers: { 'cache-control': 'only-if-cached' },
    virtualTime: T0,
  });
  check('only-if-cached 未命中 => gateway-timeout 语义', r.json.state === 'gateway-timeout');
  check('不签发令牌', r.json.token === null);
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/oic',
    headers: { 'cache-control': 'only-if-cached' },
    virtualTime: T0 + 999 * minute,
  });
  check('only-if-cached 对陈旧副本也直接返回不回源', r.json.state === 'stale' && r.json.token === null);

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/ns',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'ns',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/ns',
    headers: { 'cache-control': 'no-store' },
    virtualTime: T0,
  });
  check('no-store => bypass', r.json.state === 'bypass');

  console.log('\n[10] 寿命来源：Expires 与启发式');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/exp',
    responseHeaders: { expires: 'Thu, 01 Jan 2026 00:01:00 GMT' },
    body: 'e',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/exp', virtualTime: T0 + 59 * 1000 });
  check('Expires 59s 内 fresh', r.json.state === 'fresh');

  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/heur',
    responseHeaders: { 'last-modified': '2025-12-31T22:40:00Z' },
    body: 'h',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/heur', virtualTime: T0 + 7 * 60 * 1000 });
  check('启发式 10%×80min=8min，7min 时 fresh', r.json.state === 'fresh', r.json.numbers);
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/heur', virtualTime: T0 + 9 * 60 * 1000 });
  check('9min 时 expired', r.json.state === 'expired');

  console.log('\n[11] X-Virtual-Time 头与解释轨迹');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/hdr',
    responseHeaders: { 'cache-control': 'max-age=60' },
    body: 'hdr',
    storedAt: T0,
  });
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/hdr' }, {
    'x-virtual-time': new Date(T0).toISOString(),
  });
  check('支持 X-Virtual-Time 头', r.status === 200 && r.json.state === 'fresh');
  check('轨迹覆盖 normalize/key/lookup/age/lifetime/freshness', [
    'normalize', 'key', 'lookup', 'age', 'lifetime', 'freshness',
  ].every((s) => r.json.trail.some((t: any) => t.step === s)));

  console.log('\n[12] 决策日志与统计');
  r = await call(app, 'GET', '/cache/stats');
  check('stats 有 entries 计数', r.json.entries > 0 && r.json.decisions > 0);
  r = await call(app, 'GET', '/cache/decisions?limit=3');
  check('decision_logs 可取最近 3 条', r.json.decisions.length === 3);

  console.log('\n[13] 重置端点');
  r = await call(app, 'POST', '/admin/reset');
  check('reset 200 且计数归零', r.status === 200 && r.json.stats.entries === 0 && r.json.stats.pendingTokens === 0);
  check('reset 同时清空失效记录', r.json.stats.invalidations === 0, r.json.stats);
  r = await call(app, 'POST', '/cache/request', { url: 'https://origin.test/a', virtualTime: T0 });
  check('重置后旧键 miss', r.json.state === 'miss');

  console.log('\n[14] 参数校验');
  r = await call(app, 'POST', '/cache/request', { url: 'not-a-url', virtualTime: T0 });
  check('坏 URL => 400', r.status === 400);
  r = await call(app, 'POST', '/cache/request', { url: 'https://x.test/' });
  check('缺虚拟时间 => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/entries', {
    url: 'https://x.test/',
    storedAt: T0,
    responseHeaders: { vary: '*' },
  });
  check('Vary: * 预置被拒', r.status === 400);

  console.log('\n[15] 条件失效：Vary 精确解析 / ETag 守卫 / dryRun / 令牌释放');
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'gzip' },
    responseHeaders: { 'cache-control': 'max-age=600', etag: '"g1"', vary: 'Accept-Encoding' },
    body: 'gzip-v1',
    storedAt: T0,
  });
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/inv',
    requestHeaders: { 'accept-encoding': 'br' },
    responseHeaders: { 'cache-control': 'max-age=600', etag: '"b1"', vary: 'Accept-Encoding' },
    body: 'br-v1',
    storedAt: T0,
  });

  // dryRun：只预览，不动数据
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    dryRun: true,
  });
  check('dryRun 返回 200', r.status === 200);
  check('dryRun 预览 1 个将删除键', r.json.wouldAffectKeys.length === 1 && r.json.affectedKeys.length === 0);
  check('dryRun 被跳过的是 br 变体（variant-miss）', r.json.skipSummary['variant-miss'] === 1);
  check('dryRun 实际 deleted 为空', r.json.deleted.length === 0);
  let stats = (await call(app, 'GET', '/cache/stats')).json;
  check('dryRun 后条目仍在（entries=2）', stats.entries === 2);
  check('dryRun 也留下可追溯记录', stats.invalidations === 1);
  let req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('dryRun 不影响缓存：gzip 变体仍 fresh', req.json.state === 'fresh');

  // ETag 守卫：不符则跳过
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    expectedEtag: '"stale-etag"',
  });
  check('ETag 不符：affectedKeys 为空', r.status === 201 && r.json.affectedKeys.length === 0);
  check('跳过原因为 etag-mismatch', r.json.skipSummary['etag-mismatch'] === 1);
  check('跳过项携带期望/实际 ETag', r.json.skipped.some((s: any) =>
    s.reason === 'etag-mismatch' && s.expectedEtag === '"stale-etag"' && s.actualEtag === '"g1"'));
  req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('ETag 守卫拦下后条目仍可命中', req.json.state === 'fresh');

  // 失效前让该键进入回源：预置一个已过期条目并制造 pending 令牌
  await call(app, 'POST', '/admin/entries', {
    url: 'https://origin.test/pending',
    responseHeaders: { 'cache-control': 'max-age=0', etag: '"p1"' },
    body: 'p-body',
    storedAt: T0,
  });
  req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/pending',
    virtualTime: T0 + 999 * minute,
  });
  check('过期请求拿到 pending 令牌', req.json.action === 'must-revalidate' && req.json.token.leader === true);
  const pendingToken = req.json.token.token;

  // 正式执行：ETag 相符，删条目并释放 pending 令牌
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/pending',
    expectedEtag: 'p1', // 不带引号，自动补成 "p1"
  });
  check('expectedEtag 裸值自动补引号', r.json.expectedEtag === '"p1"');
  check('正式失效返回 201 且 affectedKeys=1', r.status === 201 && r.json.affectedKeys.length === 1);
  check('返回被删键与实际 ETag', r.json.deleted[0].etag === '"p1"');
  check('pending 回源令牌被释放', r.json.releasedTokens.length === 1 && r.json.releasedTokens[0].token === pendingToken);
  let tr = await call(app, 'GET', '/cache/tokens?all=1');
  check('令牌状态变为 released', tr.json.tokens.some((t: any) => t.token === pendingToken && t.status === 'released'));
  req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/pending',
    virtualTime: T0 + 999 * minute,
  });
  check('条目已失效 => miss 并签发新令牌（单飞槽位已释放）',
    req.json.state === 'miss' && req.json.token.leader === true && req.json.token.token !== pendingToken);

  // 正式失效只动目标变体，兄弟变体保留
  r = await call(app, 'POST', '/admin/invalidate', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    expectedEtag: '"g1"',
  });
  check('精确失效 gzip 变体', r.json.affectedKeys.length === 1 && r.json.skipSummary['variant-miss'] === 1);
  req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'gzip' },
    virtualTime: T0,
  });
  check('gzip 变体已删除 => miss', req.json.state === 'miss');
  req = await call(app, 'POST', '/cache/request', {
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    virtualTime: T0,
  });
  check('br 变体不受影响，仍 fresh', req.json.state === 'fresh' && req.json.response.body === 'br-v1');

  // HEAD 映射 GET 键空间
  r = await call(app, 'POST', '/admin/invalidate', {
    method: 'HEAD',
    url: 'https://origin.test/inv',
    headers: { 'accept-encoding': 'br' },
    expectedEtag: '"b1"',
  });
  check('HEAD 失效映射到 GET 变体并删除', r.json.keyMethod === 'GET' && r.json.affectedKeys.length === 1);

  // 不存在 / 无头匹配 / 重复失效
  r = await call(app, 'POST', '/admin/invalidate', { url: 'https://origin.test/nope' });
  check('无候选：no-candidate 跳过且无影响', r.json.affectedKeys.length === 0 && r.json.skipSummary['no-candidate'] === 1);
  r = await call(app, 'POST', '/admin/invalidate', { url: 'https://origin.test/pending' });
  check('对已删键重复失效：no-candidate', r.json.skipSummary['no-candidate'] === 1 && r.json.affectedKeys.length === 0);

  // 记录查询
  r = await call(app, 'GET', '/admin/invalidations?limit=100');
  check('失效记录可取（含此前全部操作）', Array.isArray(r.json.invalidations) && r.json.invalidations.length >= 5);
  check('记录含 dryRun 标记与 skipped 明细', r.json.invalidations.some((l: any) =>
    l.dryRun === true && Array.isArray(l.skipped)));
  stats = (await call(app, 'GET', '/cache/stats')).json;
  check('stats 含 invalidations 计数', stats.invalidations >= 5);

  // 入参校验
  r = await call(app, 'POST', '/admin/invalidate', { headers: {}, dryRun: true });
  check('缺 url => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/invalidate', { url: 'https://origin.test/inv', dryRun: 'yes' });
  check('dryRun 非布尔 => 400', r.status === 400);
  r = await call(app, 'POST', '/admin/invalidate', { url: 'bad-url' });
  check('坏 URL => 400', r.status === 400);

  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  await app.close();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
