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

// 12) Memory Defense：密钥在发送前被拦截（不触网络）
let defended = false;
try {
  await defs.tg_retain.execute({ text: '我的 key 是 sk-abcdefghijklmnopqrstuvwxyz012345' });
} catch (e) {
  defended = String(e.message).includes('疑似密钥');
}
if (!defended) throw new Error('Memory Defense 应拦截密钥');
console.log('Memory Defense 拦截密钥 → ok');

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

console.log('ALL OFFLINE TESTS PASSED');
