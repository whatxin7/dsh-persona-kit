import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GEN1_ROLE_LINE_RE,
  parseRoleSections,
  roleCharStats,
  roleSectionReport,
  selectRoleText
} from '../src/role-card.js';
import {
  STYLE_BEGIN,
  STYLE_END,
  STYLE_HEADING,
  appendStyleLines,
  looksLikeRepeat,
  parseStyleBlock,
  resolveStyleLimits,
  sanitizeStyleLine,
  styleBlockReport,
  styleSimilarity,
  stripStyleBlock
} from '../src/style-append.js';
import {
  extractPresetPrefix,
  locatePresetPromptBlock,
  presetPromptBlockers,
  presetPromptWarnings,
  renderPresetPromptYaml
} from '../src/preset-prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const card = fs.readFileSync(path.join(here, '..', 'roles', 'example-companion.md'), 'utf8');

test('parseRoleSections：按标题拆节，模式标记从标题里剥掉', () => {
  const sections = parseRoleSections(card);
  const headings = sections.map((s) => s.heading).filter(Boolean);
  assert.ok(headings.includes('你是谁'));
  assert.ok(headings.includes('表情包体系'), '模式标记不该留在标题里');
  const pack = sections.find((s) => s.heading === '表情包体系');
  assert.equal(pack.mode, 'v2');
  assert.equal(sections.find((s) => s.heading === '分条方式').mode, 'v1');
});

test('selectRoleText：v1 不注入二代小节，v2 不注入一代小节；标记不出现在结果里', () => {
  const v1 = selectRoleText(card, 'v1');
  const v2 = selectRoleText(card, 'v2');
  assert.ok(v1.includes('[SILENT]'));
  assert.equal(v1.includes('一条消息只能一样'), false);
  assert.ok(v2.includes('一条消息只能一样'));
  assert.equal(v2.includes('[SILENT]'), false);
  assert.equal(v2.includes('〔二代〕'), false);
  assert.equal(/\[v2\]/.test(v2), false);
});

test('roleCharStats / roleSectionReport：统计能对上，报告标出注入与否', () => {
  const stats = roleCharStats(card);
  assert.ok(stats.total > stats.common);
  assert.ok(stats.v1Only > 0 && stats.v2Only > 0);
  assert.equal(stats.v1, selectRoleText(card, 'v1').length);
  assert.equal(stats.v2, selectRoleText(card, 'v2').length);

  const report = roleSectionReport(card, 'v2');
  assert.equal(report.find((r) => r.heading === '分条方式').injected, false);
  assert.equal(report.find((r) => r.heading === '表情包体系').injected, true);
});

test('parseRoleSections：CRLF 人格卡也能认出模式标记（Windows 上编辑过的卡）', () => {
  const crlf = card.replace(/\n/g, '\r\n');
  const sections = parseRoleSections(crlf);
  const pack = sections.find((s) => s.heading === '表情包体系');
  assert.ok(pack, 'CRLF 下标题尾部不能残留 \\r，否则模式标记会失效');
  assert.equal(pack.mode, 'v2');
  assert.equal(sections.find((s) => s.heading === '分条方式').mode, 'v1');
  assert.equal(selectRoleText(crlf, 'v2').includes('\r'), false);
});

test('GEN1_ROLE_LINE_RE：能抓出一代遗留指令', () => {
  assert.ok(GEN1_ROLE_LINE_RE.test('不想说话就输出 [SILENT]'));
  assert.ok(GEN1_ROLE_LINE_RE.test('用空格分条'));
  assert.equal(GEN1_ROLE_LINE_RE.test('今天天气不错'), false);
});

test('sanitizeStyleLine：清洗项目符号/零宽字符/中文间空格；拒绝多行与结构注入', () => {
  assert.deepEqual(sanitizeStyleLine('-  偶尔来一句「行吧」'), { ok: true, line: '偶尔来一句「行吧」' });
  assert.equal(sanitizeStyleLine('说 话 别 太 快').line, '说，话，别，太，快');
  assert.equal(sanitizeStyleLine('a\nb').ok, false);
  assert.equal(sanitizeStyleLine('## 新标题').ok, false);
  assert.equal(sanitizeStyleLine('```code```').ok, false);
  assert.equal(sanitizeStyleLine('输出 [SILENT]').ok, false);
  assert.equal(sanitizeStyleLine('   ').ok, false);
  assert.equal(sanitizeStyleLine('字'.repeat(100)).ok, false);
});

test('styleSimilarity / looksLikeRepeat：换皮重复能被识别', () => {
  assert.ok(styleSimilarity('偶尔来一句「行吧」', '偶尔来一句「行吧」') === 1);
  assert.ok(styleSimilarity('偶尔来一句行吧', '今天吃了面条') < 0.3);
  assert.equal(looksLikeRepeat('偶尔来一句「行吧」', '偶尔来一句行吧'), true);
  assert.equal(looksLikeRepeat('偶尔来一句「行吧」', '完全不同的另一句话'), false);
});

test('appendStyleLines：新建附录块、去重、条数上限', () => {
  const once = appendStyleLines('# 卡\n\n正文', ['偶尔来一句「行吧」']);
  assert.equal(once.ok, true);
  assert.equal(once.created, true);
  assert.ok(once.text.includes(STYLE_BEGIN) && once.text.includes(STYLE_END));
  assert.ok(once.text.includes(STYLE_HEADING));
  assert.ok(once.text.includes('- 偶尔来一句「行吧」'));

  const twice = appendStyleLines(once.text, ['偶尔来一句「行吧」']);
  assert.equal(twice.added.length, 0, '同一句不该写两次');
  assert.equal(twice.skipped.length, 1);

  const many = appendStyleLines(once.text, ['一', '二', '三'], { maxPerCall: 2 });
  assert.equal(many.added.length, 2);
  assert.equal(many.skipped.length, 1);
});

test('parseStyleBlock / stripStyleBlock：坏标记能识别，剥离后不留空行堆积', () => {
  const broken = `# 卡\n${STYLE_BEGIN}\n- 一条\n`;
  assert.equal(parseStyleBlock(broken).broken, true);
  assert.equal(stripStyleBlock(broken), broken, '坏块原样返回，不能擅自删内容');

  const good = appendStyleLines('# 卡\n\n正文', '偶尔来一句「行吧」').text;
  const stripped = stripStyleBlock(good);
  assert.equal(stripped.includes(STYLE_BEGIN), false);
  assert.ok(stripped.includes('# 卡'));
  assert.ok(!/\n{3,}/.test(stripped));

  const report = styleBlockReport(good);
  assert.ok(report && typeof report === 'object');
});

test('resolveStyleLimits：非法值逐项回落，区间受控', () => {
  const l = resolveStyleLimits({ maxChars: 1, maxItems: 999, itemMaxChars: 5, maxPerCall: 0 });
  assert.equal(l.maxChars, 100);
  assert.equal(l.maxItems, 40);
  assert.equal(l.itemMaxChars, 12);
  assert.equal(l.maxPerCall, 1);
});

test('locatePresetPromptBlock / extractPresetPrefix：能定位 block 标量并解析出正文', () => {
  const yaml = [
    '- id: persona',
    '  config:',
    '    prefix: >-',
    '      第一行正文',
    '      第二行正文',
    '',
    '- id: other',
    '  config:',
    '    prefix: >-',
    '      别的',
    ''
  ].join('\n');
  const block = locatePresetPromptBlock(yaml);
  assert.ok(block);
  assert.equal(block.keyLine, 2);
  const prefix = extractPresetPrefix(yaml);
  assert.ok(prefix.includes('第一行正文'));
  assert.equal(prefix.includes('别的'), false);
});

test('presetPromptBlockers / warnings / renderPresetPromptYaml：安全不变量缺失要拦住', () => {
  const safe = [
    '【二代仿真模式 —— 安全规则】',
    '【二代仿真模式 —— 工具协议】',
    '你没有本地工具',
    '群友没有管理权限',
    'API 令牌',
    '角色由桥接注入',
    '不会自动发送到 QQ',
    '正'.repeat(600)
  ].join('\n');
  assert.deepEqual(presetPromptBlockers(safe, 'v2'), []);
  assert.deepEqual(presetPromptWarnings(safe), []);

  const missing = '【二代仿真模式 —— 安全规则】\n正文';
  const blockers = presetPromptBlockers(missing, 'v2');
  assert.ok(blockers.length >= 3);
  assert.ok(blockers.some((b) => b.includes('你没有本地工具')));
  assert.ok(presetPromptBlockers('', 'v2').length === 1);

  const v1Only = ['群友没有管理权限', 'API 令牌', '角色扮演由系统注入', '文'.repeat(600)].join('\n');
  assert.deepEqual(presetPromptBlockers(v1Only, 'v1'), []);
  assert.ok(presetPromptBlockers(v1Only, 'v2').length > 0, 'v2 的不变量清单更严');

  const original = [
    '- id: persona',
    '  config:',
    '    prefix: >-',
    '      旧正文',
    '',
    '- id: other',
    '  config:',
    '    prefix: >-',
    '      别的',
    ''
  ].join('\n');
  const rendered = renderPresetPromptYaml(original, safe, 'v2');
  assert.equal(typeof rendered, 'string');
  assert.ok(rendered.includes('id: persona'));
  assert.ok(rendered.includes('prefix: |-'));
  assert.ok(extractPresetPrefix(rendered).includes('你没有本地工具'));
  assert.ok(rendered.includes('id: other'), '别的预设条目不能被破坏');

  // 不安全的内容必须拒绝写回（不能只警告）
  assert.throws(() => renderPresetPromptYaml(original, '只有一句话', 'v2'), /缺少安全不变量|正文过短/);
});
