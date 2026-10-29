#!/usr/bin/env node
// persona CLI：人格卡体检、按仿真模式合成、追加「长出来的语气」、预设提示词校验。
//
//   persona check   roles/example-companion.md
//   persona compose roles/example-companion.md --mode v2
//   persona style   roles/example-companion.md --show
//   persona style   roles/example-companion.md --add "偶尔反问一句" --write
//   persona preset  agent.cordis.yml --preset v2
//   persona list    roles/
//
// 一切操作默认只读；只有显式 --write 才会改文件（改前会打印 diff 行数，便于回滚）。

import fs from 'node:fs';
import path from 'node:path';
import { GEN1_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';
import { appendStyleLines, parseStyleBlock, styleBlockReport, stripStyleBlock } from '../src/style-append.js';
import { extractPresetPrefix, locatePresetPromptBlock, presetPromptBlockers, presetPromptWarnings } from '../src/preset-prompt.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i];
    if (!t.startsWith('--')) args._.push(t);
    else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) args[t.slice(2)] = true;
    else {
      args[t.slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

function reportStyle(text) {
  const block = parseStyleBlock(text);
  if (!block.present) {
    console.log('语气附录  不存在（还没长出来）');
    return;
  }
  if (block.broken) {
    console.log(`语气附录  结构坏了：${block.reason}`);
    return;
  }
  console.log(`语气附录  ${block.lines.length} 条 / ${block.body.length} 字（第 ${block.beginLine + 1}~${block.endLine + 1} 行）`);
  for (const line of block.lines) console.log(`  - ${line}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] ?? 'check';

  if (cmd === 'list') {
    const dir = path.resolve(String(args._[1] ?? 'roles'));
    if (!fs.existsSync(dir)) {
      console.error(`没有目录 ${dir}`);
      return 1;
    }
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const text = readText(path.join(dir, f));
      const stats = roleCharStats(text);
      console.log(`${f.padEnd(34)} 共 ${String(stats.total).padStart(5)} 字 · v1 ${String(stats.v1).padStart(5)} · v2 ${String(stats.v2).padStart(5)}`);
    }
    console.log(`\n共 ${files.length} 张卡`);
    return files.length ? 0 : 1;
  }

  if (cmd === 'check') {
    const file = String(args._[1] ?? '');
    if (!file || !fs.existsSync(file)) {
      console.error(`用法：persona check <card.md>（找不到 ${file || '空路径'}）`);
      return 2;
    }
    const text = readText(file);
    const stats = roleCharStats(text);
    console.log(`文件      ${path.resolve(file)}`);
    console.log(`字数      共 ${stats.total} · 通用 ${stats.common} · 仅一代 ${stats.v1Only} · 仅二代 ${stats.v2Only}`);
    console.log(`注入长度  v1 ${stats.v1} 字 · v2 ${stats.v2} 字`);
    console.log('');
    for (const mode of ['v1', 'v2']) {
      console.log(`[${mode}] 小节注入情况：`);
      for (const s of roleSectionReport(text, mode)) {
        const mark = s.injected ? '✓' : '·';
        const tag = s.mode === 'all' ? '' : ` 〔${s.mode}〕`;
        console.log(`  ${mark} ${s.heading}${tag}（${s.chars} 字）`);
      }
      console.log('');
    }
    // 一代遗留指令：只查**通用小节**里的——〔一代〕小节里出现 [SILENT] 是正常的
    const leftover = [];
    for (const section of parseRoleSections(stripStyleBlock(text))) {
      if (section.mode !== 'all') continue;
      for (const line of section.lines) {
        if (GEN1_ROLE_LINE_RE.test(line)) leftover.push({ section: section.heading ?? '(开头)', line: line.trim() });
      }
    }
    if (leftover.length) {
      console.log('⚠ 一代遗留指令写在了通用小节里（二代下会被过滤，建议给该小节加 〔一代〕）：');
      for (const l of leftover) console.log(`  [${l.section}] ${l.line.slice(0, 70)}`);
      console.log('');
    }
    reportStyle(text);
    return 0;
  }

  if (cmd === 'compose') {
    const file = String(args._[1] ?? '');
    if (!file || !fs.existsSync(file)) {
      console.error('用法：persona compose <card.md> [--mode v1|v2]');
      return 2;
    }
    const mode = String(args.mode ?? 'v2');
    const text = selectRoleText(readText(file), mode);
    if (args.json) {
      console.log(JSON.stringify({ mode, chars: text.length, text }, null, 2));
      return 0;
    }
    process.stdout.write(`${text}\n`);
    return 0;
  }

  if (cmd === 'style') {
    const file = String(args._[1] ?? '');
    if (!file || !fs.existsSync(file)) {
      console.error('用法：persona style <card.md> [--show|--add "..." [--write]]');
      return 2;
    }
    const text = readText(file);
    if (args.add) {
      const result = appendStyleLines(text, String(args.add), {
        maxChars: Number(args.maxchars ?? 800),
        maxItems: Number(args.maxitems ?? 14),
        itemMaxChars: Number(args.itemmaxchars ?? 60),
        maxPerCall: Number(args.maxpercall ?? 2)
      });
      if (!result.ok) {
        console.error(`未写入：${result.reason}`);
        for (const s of result.skipped) console.error(`  跳过「${s.line}」：${s.reason}`);
        return 1;
      }
      console.log(`新增 ${result.added.length} 条，附录现 ${result.items.length} 条 / ${result.bodyChars} 字${result.created ? '（新建附录）' : ''}`);
      for (const line of result.added) console.log(`  + ${line}`);
      for (const s of result.skipped) console.log(`  · 跳过「${s.line}」：${s.reason}`);
      if (args.write) {
        fs.copyFileSync(file, `${file}.bak`);
        fs.writeFileSync(file, result.text, 'utf8');
        console.log(`已写入 ${file}（备份 ${path.basename(file)}.bak）`);
      } else {
        console.log('（dry-run：加 --write 才会落盘）');
      }
      return 0;
    }
    reportStyle(text);
    const report = styleBlockReport(text);
    if (report && typeof report === 'object') {
      for (const [k, v] of Object.entries(report)) {
        if (Array.isArray(v) && v.length) console.log(`  ${k}: ${v.join('、')}`);
      }
    }
    return 0;
  }

  if (cmd === 'preset') {
    const file = String(args._[1] ?? '');
    if (!file || !fs.existsSync(file)) {
      console.error('用法：persona preset <agent.cordis.yml> [--preset v1|v2]');
      return 2;
    }
    const text = readText(file);
    const preset = String(args.preset ?? 'v2');
    const block = locatePresetPromptBlock(text);
    const prefix = extractPresetPrefix(text);
    console.log(`文件       ${path.resolve(file)}`);
    console.log(`persona 块 ${block ? `第 ${block.keyLine + 1}~${block.blockEnd} 行` : '没找到（需要 - id: persona 下的 prefix: >-）'}`);
    console.log(`prefix     ${prefix ? `${prefix.length} 字` : '解析失败'}`);
    if (prefix) {
      const blockers = presetPromptBlockers(prefix, preset);
      const warnings = presetPromptWarnings(prefix);
      console.log(`硬性校验   ${blockers.length ? `不可保存（${blockers.length} 项）` : '通过'}`);
      for (const b of blockers) console.log(`  ✖ ${b}`);
      console.log(`软性提示   ${warnings.length ? `${warnings.length} 项` : '无'}`);
      for (const w of warnings) console.log(`  ⚠ ${w}`);
      return blockers.length ? 1 : 0;
    }
    return 1;
  }

  console.error(
    [
      '用法：',
      '  persona list    [roles/]',
      '  persona check   <card.md>',
      '  persona compose <card.md> [--mode v1|v2] [--json]',
      '  persona style   <card.md> [--show] [--add "一句话" [--write]]',
      '  persona preset  <agent.cordis.yml> [--preset v1|v2]',
      '',
      '人格卡 = roles/<名称>.md（谁、什么性格）；预设提示词 = agent.cordis.yml 的 persona.prefix（怎么用工具）。两者改完的生效方式不同。'
    ].join('\n')
  );
  return 2;
}

process.exitCode = main();

