/**
 * tg-memory-bridge 离线自检：不发任何网络请求。
 * 覆盖：inject 式注册、生命周期钩子（pre-step 注入/去重、turn-stopping 静默降级）、
 *       recall 评分/标签过滤、Memory Defense、缺 chatId 报错路径。
 * 运行：node test/offline.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../lib/index.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-test-'));
const logger = { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) };

// 模拟宿主 ctx：inject 服务就绪回调 + on 注册生命周期钩子（捕获以便直测）
function makeCtx(capture) {
  const handlers = {};
  return {
    handlers,
    inject: (names, cb) => {
      if (JSON.stringify(names) === JSON.stringify(['tools'])) {
        cb({ tools: { register: capture } });
      } else if (JSON.stringify(names) === JSON.stringify(['systemPrompt'])) {
        cb({ systemPrompt: { section: (s) => { console.log('[section]', s.name); return () => {}; } } });
      } else {
        throw new Error(`inject 服务名错误: ${names}`);
      }
    },
    on: (event, handler) => { handlers[event] = handler; },
    logger,
  };
}

// 1) 注册路径：六个工具按序注册
const names = [];
apply(makeCtx((d) => names.push(d.name)), { dataDir });
console.log('registered:', names.join(', '));
if (names.join(',') !== 'tg_status,tg_retain,tg_recall,tg_forget,tg_edit,tg_digest,tg_pin') throw new Error('工具集不符');

// 2) 拿到定义对象，直接调用 execute
const defs = {};
apply(makeCtx((d) => { defs[d.name] = d; }), { dataDir });

// 3) 造本地索引数据（绕过网络）
const rows = [
  { ts: Date.now() - 86400000 * 10, message_id: 11, chat_id: '-100123456', text: '用户偏好深夜工作，通常凌晨 2 点睡', tags: ['#fact'] },
  { ts: Date.now() - 3600000, message_id: 12, chat_id: '-100123456', text: 'hindsight-tg 项目决定用 aiogram 3 + 本地 JSONL 索引', tags: ['#hindsight-tg', '#fact'] },
  { ts: Date.now() - 60000, message_id: 13, chat_id: '-100123456', text: 'Agent 完成了 tg-bridge 插件骨架', tags: ['#exp'] },
];
fs.writeFileSync(path.join(dataDir, 'memory.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

// 4) recall：关键词命中
const r1 = await defs.tg_recall.execute({ query: '深夜工作' });
console.log('recall "深夜工作" →', r1.count, '|', r1.hits[0]?.text);
if (r1.count !== 1) throw new Error('关键词召回失败');
// 时间前缀：直接测 __internals.stampDate（retainOne 路径的实弹验证在 e2e）
const stampI = (await import('../lib/index.js')).__internals;
const st1 = stampI.stampDate('裸文本');
if (!/^\[\d{4}-\d{2}-\d{2}\] 裸文本$/.test(st1)) throw new Error('时间前缀缺失: ' + st1);
if (stampI.stampDate('[2026-01-01] 已有戳') !== '[2026-01-01] 已有戳') throw new Error('不应重复加戳');
console.log('时间前缀 + 防双戳 → ok');

// 5) recall：标签过滤
const r2 = await defs.tg_recall.execute({ tag: '#hindsight-tg' });
console.log('recall #hindsight-tg →', r2.count, '|', r2.hits[0]?.permalink);
if (r2.count !== 1) throw new Error('标签过滤失败');
if (!r2.hits[0].permalink.includes('/c/123456/12')) throw new Error('永久链接格式错误: ' + r2.hits[0].permalink);

// 6) recall：query 里内嵌 # 标签词
const r3 = await defs.tg_recall.execute({ query: 'aiogram #hindsight-tg' });
console.log('recall "aiogram #hindsight-tg" →', r3.count);
if (r3.count !== 1) throw new Error('内嵌标签过滤失败');

// 7) recall：无任何条件 → 最近优先
const r4 = await defs.tg_recall.execute({});
console.log('recall 最近 →', r4.count, '| 最新:', r4.hits[0]?.text);
if (!r4.hits[0].text.includes('插件骨架')) throw new Error('新近度排序失败');

// 8) recall：无命中
const r5 = await defs.tg_recall.execute({ query: '不存在的词' });
if (r5.count !== 0) throw new Error('无命中时应返回 0');

// 9) retain：缺 chatId 应报可行动的错误
let okErr = false;
try {
  await defs.tg_retain.execute({ text: 'x' });
} catch (e) {
  okErr = String(e.message).includes('尚未确定目标群');
}
if (!okErr) throw new Error('缺 chatId 时应报"尚未确定目标群"');

// 10) retain：参数校验
let okEmpty = false;
try {
  await defs.tg_retain.execute({ text: '  ' });
} catch (e) {
  okEmpty = String(e.message).includes('text 不能为空');
}
if (!okEmpty) throw new Error('空 text 应报错');

// 11) digest：没有新记忆（lastDigestTs 覆盖全部）→ 直接返回，不调 LLM
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ chatId: '-100123456', lastDigestTs: Date.now() + 60000 }));
const d0 = await defs.tg_digest.execute({});
if (!(d0.ok && d0.digested === 0)) throw new Error('digest 无新记忆路径失败');
console.log('digest 无新记忆 → ok（未触发 LLM）');

// 12) Memory Defense：默认 redact（值替换为 [REDACTED:type] 后才入库，不触网络）；block 拦截；CJK 邻接可检出；Luhn 信用卡
const I0 = (await import('../lib/index.js')).__internals;
const da1 = I0.defenseApply({}, '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345');
if (!(da1.hits.includes('openai_key') && da1.text.includes('[REDACTED:openai_key]') && !da1.text.includes('sk-abcdefghijklmnopqrstuvwxyz012345'))) throw new Error('redact 应脱敏');
let defended = false;
try { I0.defenseApply({ defense: 'block' }, 'sk-abcdefghijklmnopqrstuvwxyz012345'); } catch (e) { defended = String(e.message).includes('疑似密钥'); }
if (!defended) throw new Error('block 应拦截');
const da2 = I0.defenseApply({}, '凭证为sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFF用于测试');
if (!da2.text.includes('[REDACTED:anthropic_key]')) throw new Error('CJK 邻接应检出（\\b 时代漏检场景）');
const da3 = I0.defenseApply({}, '卡 4111 1111 1111 1111 与 非卡 1234 5678 9012 3456');
if (!da3.text.includes('[REDACTED:credit_card]') || !da3.text.includes('1234 5678 9012 3456')) throw new Error('Luhn 判定错误：有效卡应脱敏、非卡应保留');
if (I0.defenseApply({ defense: false }, 'sk-abcdefghijklmnopqrstuvwxyz012345').hits.length !== 0) throw new Error('defense:false 应关闭');
console.log('Memory Defense redact/block/CJK 邻接/Luhn → ok');

// 13) 生命周期：pre-step 注入（画像卡+digest）+ 去重 + turn-stopping 静默降级
const ctx2 = makeCtx(() => {});
apply(ctx2, { dataDir });
const H = ctx2.handlers;
H['agent/session-start']?.({ agent: { session: { header: { id: 't1' } } } });
fs.appendFileSync(
  path.join(dataDir, 'memory.jsonl'),
  JSON.stringify({ ts: Date.now(), message_id: 99, chat_id: '-100123456', text: '测试 digest：用户在验证生命周期注入', tags: ['#digest'] }) + '\n',
);
const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
st.cardText = '👤 测试卡';
fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(st));

const decision = { kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '帮我写个 TODO 应用' }] }] };
const callPre = () => H['agent/pre-step']({ agent: { session: { header: { id: 't1' } } } }, async () => decision);
const d1 = await callPre();
if (d1.messages.length !== 2) throw new Error('pre-step 应追加注入消息，实际 ' + d1.messages.length);
const inj = d1.messages[1];
if (inj.role !== 'user' || !String(inj.source?.kind || '').startsWith('plugin:')) throw new Error('注入消息形状不符');
if (!inj.content[0].text.includes('【置顶画像卡】') || !inj.content[0].text.includes('#digest')) throw new Error('注入应含画像卡与 digest');
const d2 = await callPre();
if (d2.messages.length !== 1) throw new Error('相同内容不应重复注入（去重失败）');
console.log('pre-step 注入 + 去重 → ok');

await H['agent/turn-stopping']?.({ agent: { session: { header: { id: 't1' } } } });
console.log('turn-stopping 静默降级（无 LLM key 不抛出）→ ok');

// 14) P0 防反馈循环：promptTextOf 跳过插件自注入消息
const I = (await import('../lib/index.js')).__internals;
const fakeInjection = { id: 'x', role: 'user', content: [{ type: 'text', text: '<tg_memory>旧记忆快照</tg_memory>' }], source: { kind: 'plugin:tg-memory-bridge', form: 'recall' } };
const p1 = I.promptTextOf([fakeInjection, { role: 'user', content: [{ type: 'text', text: '真实用户消息' }] }]);
if (p1 !== '真实用户消息') throw new Error('P0: 应取真实用户消息，得: ' + p1);
const p2 = I.promptTextOf([fakeInjection]);
if (p2 !== '') throw new Error('P0: 纯注入消息应返回空');
console.log('P0 防反馈循环（promptTextOf 跳过注入）→ ok');

// 15) 乘法组合打分：proof_count 高者同条件下排名靠前
const defsT = {};
const cap = (d) => { defsT[d.name] = d; };
apply(makeCtx(cap), { dataDir });
const extra = [
  { ts: Date.now() - 3600000, message_id: 21, chat_id: '-100123456', text: '偏好用 Vue 写前端', tags: ['#fact'], proof_count: 6 },
  { ts: Date.now() - 3600000, message_id: 22, chat_id: '-100123456', text: '偏好用 Vue 的原因未知补充', tags: ['#fact'] },
];
fs.appendFileSync(path.join(dataDir, 'memory.jsonl'), extra.map((r) => JSON.stringify(r)).join('\n') + '\n');
const qv = await defsT.tg_recall.execute({ query: '偏好' });
if (qv.hits[0]?.text.includes('原因未知')) throw new Error('乘法打分：proof_count 高者应排前');
console.log('乘法组合打分（proof 提升）→ ok，top1:', qv.hits[0]?.text.slice(0, 30));

// ───────────────────────── 16) fetch mock 基座 + digest reconcile 三态 + commit 路径 + 叙事 gate ─────────────────────────
const realFetch = globalThis.fetch;
const tgCalls = [];
let llmResponder = null;
globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  if (u.includes('api.telegram.org')) {
    const method = u.split('/').pop().split('?')[0];
    tgCalls.push({ method, payload: JSON.parse(options.body ?? '{}') });
    const result = method === 'sendMessage'
      ? { message_id: 500 + tgCalls.filter((c) => c.method === 'sendMessage').length }
      : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }), json: async () => ({ ok: true, result }) };
  }
  if (u.includes('mock-llm.test')) {
    const content = llmResponder ? llmResponder(JSON.parse(options.body ?? '{}')) : '{}';
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }), json: async () => ({ choices: [{ message: { content } }] }) };
  }
  return realFetch(url, options);
};

function makeReconcileScenario() {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-rc-'));
  const T = Date.now();
  fs.writeFileSync(path.join(dir2, 'memory.jsonl'), [
    { ts: T - 5000, message_id: 300, chat_id: '-100123456', text: '用户在验证 tg_digest 整理功能', tags: ['#digest'], proof_count: 2, evidence_quotes: [{ quote: '用户正在验证', ts: T - 9000 }] },
    { ts: T - 4000, message_id: 301, chat_id: '-100123456', text: 'Agent 完成了 reconcile 化改造', tags: ['#exp'] },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir2, 'state.json'), JSON.stringify({ chatId: '-100123456', lastDigestTs: T - 6000, pinnedMessageId: 400, cardText: '旧卡' }));
  const d2 = {};
  apply(makeCtx((d) => { d2[d.name] = d; }), { dataDir: dir2, token: '123456789:AAFakeTokenForOfflineTests00000', llmApiKey: 'test-key', llmBaseURL: 'https://mock-llm.test/v1' });
  return { dir2, d2, T };
}
const readIdx = (dir2) => fs.readFileSync(path.join(dir2, 'memory.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// 16a) reinforce：原位 editMessageText（无 sendMessage），proof_count+1，append_note 入文本
{
  const { dir2, d2 } = makeReconcileScenario();
  tgCalls.length = 0;
  llmResponder = () => JSON.stringify({ action: 'reinforce', append_note: '完成了 reconcile 化改造（佐证）', evidence_quotes: ['Agent 完成了 reconcile 化改造'], insights: ['对账已验证'] });
  const out = await d2.tg_digest.execute({});
  const idx = readIdx(dir2).find((e) => e.message_id === 300);
  if (out.action !== 'reinforce' || tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('reinforce 不应发新消息');
  if (idx.proof_count !== 3 || idx.evidence_quotes.length !== 2 || !idx.text.includes('reconcile 化改造（佐证）')) throw new Error('reinforce 索引更新错误');
  if (!tgCalls.some((c) => c.method === 'editMessageText' && c.payload.message_id === 300)) throw new Error('reinforce 应原位编辑 #300');
  console.log('digest reconcile reinforce → ok（原位编辑，proof_count=3）');
}
// 16b) refine：全文原位替换 + 证据入库
{
  const { dir2, d2 } = makeReconcileScenario();
  tgCalls.length = 0;
  llmResponder = () => JSON.stringify({ action: 'refine', text: '用户验证并完成了 tg_digest 对账化；此前以为 digest 只是快照，现在升级为信念系统', evidence_quotes: ['完成了 reconcile 化改造'], insights: ['观察层升级'] });
  const out = await d2.tg_digest.execute({});
  const idx = readIdx(dir2).find((e) => e.message_id === 300);
  if (out.action !== 'refine' || tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('refine 不应发新消息');
  if (!idx.text.includes('此前以为') || idx.proof_count !== 3 || idx.evidence_quotes.length !== 2) throw new Error('refine 索引更新错误');
  console.log('digest reconcile refine → ok（历史保留句式 + 证据入库）');
}
// 16c) new：全新主题 → sendMessage + 新条目
{
  const { dir2, d2 } = makeReconcileScenario();
  tgCalls.length = 0;
  llmResponder = () => JSON.stringify({ action: 'new', text: '全新观察：用户开始规划语义召回（sqlite-vec）', evidence_quotes: ['开始规划语义召回'], insights: ['二期启动'] });
  const out = await d2.tg_digest.execute({});
  const idx = readIdx(dir2).find((e) => String(e.text).includes('语义召回'));
  if (out.action !== 'new' || !tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('new 应发新消息');
  if (!idx || idx.proof_count !== 1 || idx.tags[0] !== '#digest') throw new Error('new 索引条目错误');
  console.log('digest reconcile new → ok（新消息 + 证据链字段）');
}
// 16d) JSON 解析失败 → 回退全量新 digest（交接文档降级路径）
{
  const { dir2, d2 } = makeReconcileScenario();
  tgCalls.length = 0;
  llmResponder = () => '这不是 JSON，只是普通归纳文本';
  const out = await d2.tg_digest.execute({});
  if (out.action !== 'new' || !tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('解析失败应回退 new 路径');
  console.log('digest JSON 解析失败回退 → ok');
}
// 16e) commit 路径（子代理回传）：不经 LLM 直接三态应用
{
  const { dir2, d2 } = makeReconcileScenario();
  tgCalls.length = 0;
  llmResponder = () => { throw new Error('commit 路径不应调 LLM'); };
  const out = await d2.tg_digest.execute({ commit: { action: 'refine', digest: '对账完成：观察层已升级', evidence_quotes: ['对账完成'], insights: ['commit 通路 OK'] } });
  const idx = readIdx(dir2).find((e) => e.message_id === 300);
  if (out.action !== 'refine' || !idx.text.includes('对账完成')) throw new Error('commit refine 失败');
  if (tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('commit refine 不应发新消息');
  console.log('digest commit 回传路径 → ok（不调 LLM）');
}
// 16f) handoff 载荷带 old_digest（对账基准）
{
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-ho-'));
  fs.writeFileSync(path.join(d3, 'memory.jsonl'), [
    { ts: Date.now() - 5000, message_id: 300, chat_id: '-100123456', text: '旧观察', tags: ['#digest'], proof_count: 1 },
    { ts: Date.now() - 4000, message_id: 301, chat_id: '-100123456', text: '新事实', tags: ['#fact'] },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(d3, 'state.json'), JSON.stringify({ chatId: '-100123456', lastDigestTs: Date.now() - 6000 }));
  const dd = {};
  apply(makeCtx((d) => { dd[d.name] = d; }), { dataDir: d3 });
  const h = await dd.tg_digest.execute({});
  if (h.mode !== 'subagent-handoff' || h.pending_count !== 1 || !h.old_digest || h.old_digest.message_id !== 300) throw new Error('handoff 应带 old_digest 基准');
  if (!String(h.instruction).includes('reinforce')) throw new Error('handoff instruction 应含对账契约');
  console.log('digest handoff 携带对账基准 → ok');
}
// 17) 叙事抽取 gate：turn-stopping + mock LLM → 多 facts 逐条 retain；空 facts 不写入
{
  const d4 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-gate-'));
  const ctx4 = makeCtx(() => {});
  apply(ctx4, { dataDir: d4, token: '123456789:AAFakeTokenForOfflineTests00000', llmApiKey: 'test-key', llmBaseURL: 'https://mock-llm.test/v1' });
  ctx4.handlers['agent/session-start']?.({ agent: { session: { header: { id: 'g1' } } } });
  fs.writeFileSync(path.join(d4, 'state.json'), JSON.stringify({ chatId: '-100123456' }));
  const callPre4 = (text) => ctx4.handlers['agent/pre-step']({ agent: { session: { header: { id: 'g1' } } } }, async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text }] }] }));
  tgCalls.length = 0;
  llmResponder = (body) => {
    const sys = body?.messages?.[0]?.content ?? '';
    if (sys.includes('叙事抽取')) return JSON.stringify({ facts: [{ text: '用户偏好 socks5 代理', tags: ['#fact'] }, { text: 'Agent 完成了迁移', tags: ['#exp'] }] });
    return '{"facts":[]}';
  };
  await callPre4('今天把迁移搞完了，我用 socks5');
  await ctx4.handlers['agent/turn-stopping']?.({ agent: { session: { header: { id: 'g1' } } } });
  const idx = readIdx(d4);
  if (!idx.some((e) => e.text.includes('socks5 代理') && e.tags.includes('#fact'))) throw new Error('叙事 gate #fact 未入库');
  if (!idx.some((e) => e.text.includes('完成了迁移') && e.tags.includes('#exp'))) throw new Error('叙事 gate #exp 未入库');
  // 时间前缀（retainOne 自动加戳）
  if (!idx.some((e) => /^\[\d{4}-\d{2}-\d{2}\] /.test(e.text))) throw new Error('自动沉淀应带时间前缀');
  llmResponder = (body) => (String(body?.messages?.[0]?.content ?? '').includes('叙事抽取') ? '{"facts":[]}' : '{}');
  tgCalls.length = 0;
  await callPre4('随便聊聊');
  await ctx4.handlers['agent/turn-stopping']?.({ agent: { session: { header: { id: 'g1' } } } });
  if (tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('空 facts 不应写入');
  console.log('叙事抽取 gate（多 facts/空 facts/时间前缀）→ ok');
}

// 18) 相关记忆注入：prompt 命中 → 注入含【相关记忆】段 + permalink；无命中 → 无注入
{
  const d5 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-rel-'));
  fs.writeFileSync(path.join(d5, 'memory.jsonl'), [
    { ts: Date.now() - 60000, message_id: 601, chat_id: '-100123456', text: '用户偏好 socks5 代理上网', tags: ['#fact'] },
    { ts: Date.now() - 60000, message_id: 602, chat_id: '-100123456', text: '无关条目：今天天气不错', tags: ['#fact'] },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(d5, 'state.json'), JSON.stringify({ chatId: '-100123456' }));
  const ctx5 = makeCtx(() => {});
  apply(ctx5, { dataDir: d5 });
  ctx5.handlers['agent/session-start']?.({ agent: { session: { header: { id: 'r1' } } } });
  const out = await ctx5.handlers['agent/pre-step']({ agent: { session: { header: { id: 'r1' } } } }, () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: 'socks5 代理还能用吗' }] }] }));
  const injText = out.messages[out.messages.length - 1]?.content?.[0]?.text ?? '';
  if (!injText.includes('【相关记忆')) throw new Error('命中 prompt 应注入相关记忆段');
  if (!injText.includes('socks5 代理上网') || !injText.includes('/c/123456/601')) throw new Error('相关记忆内容/永久链接缺失');
  const out2 = await ctx5.handlers['agent/pre-step']({ agent: { session: { header: { id: 'r2' } } } }, () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '今天午饭吃什么' }] }] }));
  if (out2.messages.length !== 1) throw new Error('无命中且无卡/digest 时不应注入');
  console.log('相关记忆注入（命中/无命中/预算）→ ok');
}
// 19) 会话事件流去重（官方 lastInjectedText 同款，重启安全）+ 单元
{
  const I2 = (await import('../lib/index.js')).__internals;
  const evs = [
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '普通消息' }] } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '更早的注入' }], source: { kind: 'plugin:tg-memory-bridge', form: 'recall' } } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: '普通消息2' }] } },
  ];
  if (I2.lastInjectedText(evs, 'tg-memory-bridge') !== '更早的注入') throw new Error('lastInjectedText 应反向扫描命中插件消息');
  if (I2.lastInjectedText([], 'tg-memory-bridge') !== null) throw new Error('空事件流应返回 null');
  const d6 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-ev-'));
  fs.writeFileSync(path.join(d6, 'state.json'), JSON.stringify({ chatId: '-100123456', cardText: '卡片A' }));
  const ctx6 = makeCtx(() => {});
  apply(ctx6, { dataDir: d6 });
  const out1 = await ctx6.handlers['agent/pre-step']({ agent: { session: { header: { id: 'e1' } } } }, () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '随便说' }] }] }));
  const injected = out1.messages[out1.messages.length - 1].content[0].text;
  if (!injected.includes('卡片A')) throw new Error('首次应注入');
  // 新进程（sessions 为空），但会话事件里已有同内容注入 → 应跳过（重启安全）
  const ctx7 = makeCtx(() => {});
  apply(ctx7, { dataDir: d6 });
  const sessionWithEvents = { header: { id: 'e1' }, events: [{ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: injected }], source: { kind: 'plugin:tg-memory-bridge', form: 'recall' } } }] };
  const out2 = await ctx7.handlers['agent/pre-step']({ agent: { session: sessionWithEvents } }, () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '随便说' }] }] }));
  if (out2.messages.length !== 1) throw new Error('事件流去重失败：同内容不应再次注入');
  console.log('会话事件流去重（重启安全）→ ok');
}

// 20) 多卡心智模型：tg_pin(name) 创建→原位更新；profile 与命名卡互不干扰
{
  const d7 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-cards-'));
  const dd = {};
  const ctx8 = makeCtx((d) => { dd[d.name] = d; });
  apply(ctx8, { dataDir: d7, token: '123456789:AAFakeTokenForOfflineTests00000' });
  fs.writeFileSync(path.join(d7, 'state.json'), JSON.stringify({ chatId: '-100123456', pinnedMessageId: 54, cardText: '主卡旧' }));
  tgCalls.length = 0;
  const r1 = await dd.tg_pin.execute({ text: '项目卡 v1', name: '项目卡' });
  if (!r1.ok || r1.name !== '项目卡' || r1.edited) throw new Error('命名卡应新建');
  if (!tgCalls.some((c) => c.method === 'pinChatMessage' && c.payload.message_id === r1.message_id)) throw new Error('命名卡应置顶');
  const st = JSON.parse(fs.readFileSync(path.join(d7, 'state.json'), 'utf8'));
  if (st.pinnedMessageId !== 54 || st.cardText !== '主卡旧') throw new Error('主卡不应被动');
  if (!st.cards?.['项目卡']?.message_id) throw new Error('命名卡未入 state.cards');
  tgCalls.length = 0;
  const r2 = await dd.tg_pin.execute({ text: '项目卡 v2', name: '项目卡' });
  if (!r2.edited || tgCalls.some((c) => c.method === 'sendMessage')) throw new Error('命名卡第二次应原位编辑，不发新消息');
  if (JSON.parse(fs.readFileSync(path.join(d7, 'state.json'), 'utf8')).cards['项目卡'].text !== '项目卡 v2') throw new Error('命名卡文本未更新');
  const r3 = await dd.tg_pin.execute({ text: '主卡新' });
  if (r3.name !== 'profile' || !r3.edited) throw new Error('缺省 name 应走 profile 原位更新');
  if (JSON.parse(fs.readFileSync(path.join(d7, 'state.json'), 'utf8')).cardText !== '主卡新') throw new Error('主卡文本未更新');
  console.log('多卡心智模型（create/edit/隔离）→ ok');
}
// 21) tg_edit 命中命名卡 → cards[n].text 同步
{
  const d8 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-mem-edit-'));
  fs.writeFileSync(path.join(d8, 'state.json'), JSON.stringify({ chatId: '-100123456', pinnedMessageId: 54, cardText: '主卡', cards: { '项目卡': { message_id: 55, text: '旧项目卡' } } }));
  const de = {};
  const ctx9 = makeCtx((d) => { de[d.name] = d; });
  apply(ctx9, { dataDir: d8, token: '123456789:AAFakeTokenForOfflineTests00000' });
  tgCalls.length = 0;
  await de.tg_edit.execute({ message_id: 55, text: '新项目卡内容' });
  const st = JSON.parse(fs.readFileSync(path.join(d8, 'state.json'), 'utf8'));
  if (st.cards['项目卡'].text !== '新项目卡内容' || st.cardText !== '主卡') throw new Error('命名卡同步失败');
  console.log('tg_edit 命名卡同步 → ok');
}

globalThis.fetch = realFetch;
console.log('ALL OFFLINE TESTS PASSED');
