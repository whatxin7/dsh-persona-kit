// 角色卡尾部「附：长出来的语气」自动追加区。
//
// 为什么要单独一个区：角色卡前十三节是「人写的设定」，节编号还被 preset 引用
// （第十一~十三节），任何自动写入都必须**不碰**它们。所以自动写入只允许落在一个
// 带注释标记的附录块里，块的边界由 <!-- style:begin --> / <!-- style:end --> 圈定：
//   · 结构检查脚本（check-role-card / apply-role-card）先剥掉这个块再数节数，
//     所以块内出现 `## ` 标题也不会污染「必须 13 节」的硬校验；
//   · 桥接注入时整篇注入（parseRoleSections 把附录当一个 mode=all 的小节），
//     所以写进去的句子立刻影响说话，不需要重启。
//
// 设计原则（写给后来改这个文件的人）：
//   1. 只追加，不修改、不删除——历史由 state/role-backups 兜底，不是由这个模块兜底。
//   2. 逐条校验：一行一条、限长、禁标题/代码块/标记/一代仿真指令，防止「一行字」
//      变成「一张新角色卡」（提示注入的常见形态就是从被污染的文字里长出新的规则）。
//   3. 重复与近似重复一律跳过，避免同一句换皮堆满预算（附录挤满会把正文顶出注入上限）。
//   4. 这里只做文本层面的纯函数，不碰 fs、不知道 roles 目录在哪——落盘、备份、
//      限频、权限都在 bridge.js，测试可以只跑这个文件。

export const STYLE_BEGIN = '<!-- style:begin -->';
export const STYLE_END = '<!-- style:end -->';
export const STYLE_HEADING = '## 附：长出来的语气';
export const STYLE_INTRO = '（下面是你自己在群里长出来的说话习惯，按它说话；这里只放语气，不写设定和规则）';

// 默认上限。config.json 的 socialV2.style 可覆盖。
export const STYLE_LIMITS = {
  maxChars: 800,     // 附录正文总字数（不含标题与标记）
  maxItems: 14,      // 附录最多几条
  itemMaxChars: 60,  // 单条最长
  maxPerCall: 2      // 一次工具调用最多写几条
};

// 一代仿真遗留指令：这些词进卡会被 currentRoleHintV2 的兜底过滤整行丢掉，
// 写进去等于白写，所以直接在入口拒绝（比写进去再被悄悄吞掉诚实）。
const GEN1_TOKENS = [/\[SILENT\]/i, /空格分隔|按空格|用空格|空格分句|空格代表|自动转发|输出\s*\[SILENT\]/i];
// 结构注入形态：标题、代码块、注释、HTML、style 标记本身。
const STRUCTURE_TOKENS = [/^\s*#{1,6}\s/, /```/, /<!--|-->/, /<\/?[a-z][^>]*>/i, /style:(begin|end)/i];

function nf(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把 config.json 里的 socialV2.style 并入默认上限（非法值逐项回落）。 */
export function resolveStyleLimits(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    maxChars: nf(src.maxChars, STYLE_LIMITS.maxChars, 100, 3000),
    maxItems: nf(src.maxItems, STYLE_LIMITS.maxItems, 1, 40),
    itemMaxChars: nf(src.itemMaxChars, STYLE_LIMITS.itemMaxChars, 12, 200),
    maxPerCall: nf(src.maxPerCall, STYLE_LIMITS.maxPerCall, 1, 5)
  };
}

/**
 * 清洗一条候选：去项目符号、压空白、去零宽字符。
 * @returns {{ok: boolean, line?: string, reason?: string}}
 */
export function sanitizeStyleLine(raw, limits = STYLE_LIMITS) {
  const max = nf(limits?.itemMaxChars, STYLE_LIMITS.itemMaxChars, 12, 200);
  if (typeof raw !== 'string') return { ok: false, reason: '内容必须是文本' };
  let line = raw.replace(/\r/g, '');
  if (/\n/.test(line)) return { ok: false, reason: '一次只写一条，不要把多行塞进同一条' };
  line = line
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\t/g, ' ')
    .replace(/^\s*[-*·•+]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s+|\s+$/g, '');
  // 中文之间的空格在二代注入里会被改写成逗号（见 bridge.js convertExampleSpacesToComma），
  // 与其让它们被静默改写，不如在这里就改成中文逗号，卡上和提示词里保持一致。
  line = line.replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1，');
  if (!line) return { ok: false, reason: '内容为空' };
  if (!/[\u4e00-\u9fffA-Za-z0-9]/.test(line)) return { ok: false, reason: '内容里没有实际文字' };
  for (const re of STRUCTURE_TOKENS) {
    if (re.test(line)) return { ok: false, reason: '不能写入标题、代码块、HTML 或标记：附录只收「说话习惯」这一行' };
  }
  for (const re of GEN1_TOKENS) {
    if (re.test(line)) return { ok: false, reason: '这句话是一代仿真的旧指令，写进二代角色卡会被过滤掉' };
  }
  if (line.length > max) return { ok: false, reason: `单条最多 ${max} 字，这条 ${line.length} 字` };
  return { ok: true, line };
}

/** 去重用的归一化键：忽略标点、空白、大小写。 */
export function styleKey(line) {
  return String(line ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：,.!?;:"'“”‘’（）()【】\[\]「」『』…—~～-]/g, '');
}

/** 字符 n 元组 Jaccard 相似度（0~1）。 */
function gramJaccard(a, b, n) {
  const gram = (s) => {
    const chars = Array.from(s);
    if (!chars.length) return new Set();
    if (chars.length < n) return new Set(chars);
    const out = new Set();
    for (let i = 0; i <= chars.length - n; i++) out.add(chars.slice(i, i + n).join(''));
    return out;
  };
  const A = gram(a);
  const B = gram(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/**
 * 相似度取「单字 + 二元组」两者的较大值。
 * 只用二元组会把「同一句换几个字」判得偏低（实测 0.47），只用单字又会把
 * 「换了主语但说的是另一件事」判得偏高；中文短句上两者的较大值最稳。
 */
export function styleSimilarity(a, b) {
  const ka = styleKey(a);
  const kb = styleKey(b);
  return Math.max(gramJaccard(ka, kb, 1), gramJaccard(ka, kb, 2));
}

const SIMILAR_THRESHOLD = 0.5;

/** 近似重复判定：一边包含另一边（且够长），或二元组重合度过半。 */
export function looksLikeRepeat(a, b) {
  const ka = styleKey(a);
  const kb = styleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  if (shorter.length >= 6 && longer.includes(shorter)) return true;
  return styleSimilarity(a, b) >= SIMILAR_THRESHOLD;
}

/**
 * 解析附录块。marker 位置按整行匹配（避免正文里偶然出现同样的字符串）。
 * @returns {{present: boolean, broken: boolean, reason?: string, lines: string[], body: string,
 *            beginLine: number, endLine: number, headingLine: number, headingOk: boolean}}
 */
export function parseStyleBlock(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let beginLine = -1;
  let endLine = -1;
  let dupBegin = 0;
  let dupEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === STYLE_BEGIN) {
      if (beginLine === -1) beginLine = i;
      else dupBegin += 1;
    } else if (t === STYLE_END) {
      if (endLine === -1 && beginLine !== -1) endLine = i;
      else dupEnd += 1;
    }
  }
  const base = {
    present: false, broken: false, lines: [], body: '',
    beginLine: -1, endLine: -1, headingLine: -1, headingOk: false
  };
  if (beginLine === -1 && endLine === -1) return base;
  if (beginLine === -1 || endLine === -1 || endLine < beginLine) {
    return { ...base, present: beginLine !== -1 || endLine !== -1, broken: true, reason: 'style 标记不成对（begin/end 必须同时存在且顺序正确）' };
  }
  if (dupBegin || dupEnd) {
    return { ...base, present: true, broken: true, beginLine, endLine, reason: 'style 标记重复出现（只允许一对）' };
  }
  let headingLine = -1;
  let headingOk = false;
  const items = [];
  for (let i = beginLine + 1; i < endLine; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) continue;
    if (/^##\s+/.test(t)) {
      if (headingLine === -1 && t === STYLE_HEADING) { headingLine = i; headingOk = true; continue; }
      // 附录里出现别的标题：不解析成条目，但也不在这里报错——
      // stripStyleBlock 会把整块剥掉，结构检查因此不会被它污染。
      continue;
    }
    if (headingLine === -1 || i < headingLine) continue;
    if (/^\s*[-*·•+]\s+/.test(raw)) items.push(raw.trim().replace(/^\s*[-*·•+]\s+/, ''));
    else if (t === STYLE_INTRO) continue;
    // 既不是条目也不是说明行：忽略（手写的散句不参与条数统计，但依然会被注入）
  }
  return {
    present: true,
    broken: false,
    lines: items,
    body: lines.slice(beginLine + 1, endLine).join('\n').trim(),
    beginLine,
    endLine,
    headingLine,
    headingOk
  };
}

/** 剥掉附录块（连同块后可能留下的一个空行），给结构检查脚本用。 */
export function stripStyleBlock(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const block = parseStyleBlock(src);
  if (!block.present || block.broken) return src;
  const lines = src.split('\n');
  const rest = [...lines.slice(0, block.beginLine), ...lines.slice(block.endLine + 1)];
  // 块原本前面可能留了空行；收掉尾部多余空行，避免反复追加/剥离后不断长空行。
  return rest.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

function buildBlockLines(items) {
  return [STYLE_BEGIN, STYLE_HEADING, STYLE_INTRO, ...items.map((t) => `- ${t}`), STYLE_END];
}

/**
 * 往角色卡尾部追加若干条说话习惯。
 * @param {string} text 当前角色卡全文
 * @param {string[]|string} rawLines 候选（字符串按单条处理）
 * @param {{maxChars?:number,maxItems?:number,itemMaxChars?:number,maxPerCall?:number}} rawLimits
 * @returns {{ok:boolean, reason?:string, text:string, added:string[], skipped:{line:string,reason:string}[],
 *            items:string[], bodyChars:number, created:boolean}}
 */
export function appendStyleLines(text, rawLines, rawLimits = STYLE_LIMITS) {
  const limits = resolveStyleLimits(rawLimits);
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const block = parseStyleBlock(src);
  if (block.broken) {
    return { ok: false, reason: block.reason ?? 'style 区块结构坏了，未写入', text: src, added: [], skipped: [], items: [], bodyChars: 0, created: false };
  }
  const candidates = (Array.isArray(rawLines) ? rawLines : [rawLines]).filter((x) => typeof x === 'string' && x.trim());
  if (!candidates.length) {
    return { ok: false, reason: '没有可写入的内容', text: src, added: [], skipped: [], items: block.lines, bodyChars: block.body.length, created: false };
  }

  const added = [];
  const skipped = [];
  const items = [...block.lines];
  let bodyChars = items.reduce((n, line) => n + line.length, 0) + Math.max(0, items.length - 1);

  for (const raw of candidates) {
    if (added.length >= limits.maxPerCall) {
      skipped.push({ line: String(raw).slice(0, 60), reason: `一次最多写 ${limits.maxPerCall} 条` });
      continue;
    }
    const clean = sanitizeStyleLine(raw, limits);
    if (!clean.ok) { skipped.push({ line: String(raw).slice(0, 60), reason: clean.reason }); continue; }
    const line = clean.line;
    const key = styleKey(line);
    if (!key) { skipped.push({ line: line.slice(0, 60), reason: '内容里没有实际文字' }); continue; }
    const dup = items.find((it) => styleKey(it) === key);
    const near = dup ? null : items.find((it) => looksLikeRepeat(it, line));
    if (dup) { skipped.push({ line, reason: '已经写过了' }); continue; }
    if (near) { skipped.push({ line, reason: '和已有条目太像（同一条换皮不算新习惯）' }); continue; }
    if (items.length >= limits.maxItems) { skipped.push({ line, reason: `附录已满（最多 ${limits.maxItems} 条），先删旧条目` }); continue; }
    const nextChars = bodyChars + line.length + (items.length ? 1 : 0);
    if (nextChars > limits.maxChars) { skipped.push({ line, reason: `附录已满（最多 ${limits.maxChars} 字），先删旧条目` }); continue; }
    items.push(line);
    bodyChars = nextChars;
    added.push(line);
  }

  if (!added.length) {
    return { ok: true, text: src, added, skipped, items, bodyChars, created: false };
  }

  let next;
  if (!block.present) {
    const head = src.replace(/\s+$/, '');
    next = `${head}\n\n${buildBlockLines(items).join('\n')}\n`;
  } else {
    // 已有块：只把新条目插到 end 标记之前，块里原有内容（标题、说明、旧条目、手写散句）
    // 一个字都不重排——「只追加」在这里必须是字面意思，否则手改过的行会被悄悄抹掉。
    const lines = src.split('\n');
    const bullets = added.map((t) => `- ${t}`);
    if (block.headingOk) {
      next = [...lines.slice(0, block.endLine), ...bullets, ...lines.slice(block.endLine)].join('\n');
    } else {
      // 自愈：标记在但标题/说明行被手工删掉时补回来（只补，不改别的）。
      next = [
        ...lines.slice(0, block.beginLine + 1),
        STYLE_HEADING,
        STYLE_INTRO,
        ...lines.slice(block.beginLine + 1, block.endLine),
        ...bullets,
        ...lines.slice(block.endLine)
      ].join('\n');
    }
  }
  if (!next.endsWith('\n')) next += '\n';
  return { ok: true, text: next, added, skipped, items, bodyChars, created: !block.present };
}

/**
 * 体检附录：给 check-role-card.mjs 用的结构化报告。
 * @returns {{present:boolean, broken:boolean, problems:string[], warnings:string[], items:number, bodyChars:number}}
 */
export function styleBlockReport(text, rawLimits = STYLE_LIMITS) {
  const limits = resolveStyleLimits(rawLimits);
  const block = parseStyleBlock(text);
  const problems = [];
  const warnings = [];
  if (!block.present) return { present: false, broken: false, problems, warnings, items: 0, bodyChars: 0 };
  if (block.broken) problems.push(block.reason ?? 'style 区块结构坏了');
  if (!block.headingOk) problems.push(`附录标题必须恰好是「${STYLE_HEADING}」`);
  if (block.lines.length > limits.maxItems) problems.push(`附录条目 ${block.lines.length} 条，超过上限 ${limits.maxItems}`);
  if (block.body.length > limits.maxChars) problems.push(`附录正文 ${block.body.length} 字，超过上限 ${limits.maxChars}`);
  for (const line of block.lines) {
    const clean = sanitizeStyleLine(line, limits);
    if (!clean.ok) problems.push(`附录条目不合格（${clean.reason}）：${line.slice(0, 40)}`);
    else if (clean.line !== line) warnings.push(`附录条目写法不规范（会被规范化）：${line.slice(0, 40)}`);
  }
  return { present: true, broken: block.broken, problems, warnings, items: block.lines.length, bodyChars: block.body.length };
}
