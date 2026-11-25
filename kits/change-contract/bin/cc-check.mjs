#!/usr/bin/env node
/**
 * cc-check —— 变更契约校验（change-contract kit）
 *
 * 用法：
 *   cc-check --file <设计文档 / MR 描述.md> [--json]
 *   cat <描述.md> | cc-check [--json]
 *
 * 校验最小集（见 knowledge/change-contract.md §4 Gate 2）：
 *   1. 存在「## 变更影响面」段；
 *   2. 有「分级：A|B|C」；
 *   3. B/C 级声明「交互契约：不变」；
 *   4. A 级有「确认人：<非空>」与「依据：<非空>」。
 *
 * 退出码：0 通过 / 1 不通过 / 2 用法错误。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SECTION_TITLE = '变更影响面';

const FULLWIDTH = /[：:]/;
const EMPTY_VALUES = new Set(['', '—', '-', '–', '无', 'n/a', 'na', 'tbd', '待定']);

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 取出「## 变更影响面」段（到下一个同级或更高级标题为止）。 */
export function extractSection(text, title = SECTION_TITLE) {
  const lines = String(text ?? '').split(/\r?\n/);
  const startPattern = new RegExp(`^\\s{0,3}#{1,6}\\s*${escapeRegExp(title)}`);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(startPattern);
    if (m) {
      start = i;
      level = (lines[i].match(/^#{1,6}/) || [''])[0].length;
      break;
    }
  }
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const h = lines[i].match(/^(#{1,6})\s/);
    if (h && h[1].length <= level) break;
    out.push(lines[i]);
  }
  return { title: lines[start].trim(), body: out.join('\n') };
}

/** 取值：`key：value` / `key: value`，允许前后空格。 */
export function readField(body, key) {
  const re = new RegExp(`^\\s*[-*]?\\s*${key}\\s*${FULLWIDTH.source}\\s*(.*)$`, 'm');
  const m = String(body ?? '').match(re);
  return m ? m[1].trim() : null;
}

function isFilled(value) {
  const v = String(value ?? '').trim();
  if (!v || EMPTY_VALUES.has(v.toLowerCase())) return false;
  return !v.startsWith('<') && !/^待填/.test(v);
}

/** 统计契约表的数据行（去掉表头与分隔行）。 */
export function countContractRows(body) {
  const rows = String(body ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'));
  if (rows.length === 0) return 0;
  const data = rows.filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line));
  return Math.max(0, data.length - 1); // 去掉表头
}

/**
 * 主校验。
 * @returns {{ok:boolean, level:string|null, errors:string[], warnings:string[], rows:number}}
 */
export function checkContract(text) {
  const errors = [];
  const warnings = [];

  const section = extractSection(text);
  if (!section) {
    return {
      ok: false,
      level: null,
      errors: [`缺少「## ${SECTION_TITLE}」段（变更类型 / 契约 diff / 确认人都放这里）`],
      warnings,
      rows: 0,
    };
  }

  const body = section.body;
  const levelRaw = readField(body, '分级');
  const levelMatch = (levelRaw || '').trim().match(/^([ABC])(?=\s|$|[（(·—-])/);
  const level = levelMatch ? levelMatch[1].toUpperCase() : null;
  if (!level) errors.push('缺少「分级：A|B|C」（A 交互级 / B 数据级 / C 缺陷级）');

  if (level === 'B' || level === 'C') {
    const claim = (readField(body, '交互契约') || '').trim();
    if (!/^不变/.test(claim)) {
      errors.push(`${level} 级必须声明「交互契约：不变」；有感知变化就应判 A 级`);
    }
  }

  if (level === 'A') {
    const owner = readField(body, '确认人');
    const basis = readField(body, '依据');
    if (!isFilled(owner)) errors.push('A 级必须写「确认人：<姓名>」（谁批准了这次交互变化）');
    if (!isFilled(basis)) errors.push('A 级必须写「依据：<需求/沟通链接>」（需求面授权来源）');
  }

  const rows = countContractRows(body);
  if ((level === 'A' || level === 'B') && rows < 8) {
    warnings.push(`契约表只有 ${rows} 行；8 个字段（含「不变」项）都要写，证明对照过旧行为`);
  }
  if (/待确认|待定|TBD/i.test(body)) {
    warnings.push('段内仍有「待确认/待定」：放开灰度前必须关闭');
  }

  return { ok: errors.length === 0, level, errors, warnings, rows };
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'cc-check --file <md> [--json]\n' +
        '  校验「## 变更影响面」：分级 A/B/C、B/C 声明交互不变、A 级确认人+依据\n',
    );
    return 0;
  }
  const json = args.includes('--json');
  const fileIdx = args.findIndex((a) => a === '--file' || a === '-f');
  let text = '';
  try {
    if (fileIdx !== -1) {
      const path = args[fileIdx + 1];
      if (!path) {
        process.stderr.write('cc-check: --file 需要一个路径\n');
        return 2;
      }
      text = readFileSync(path, 'utf8');
    } else {
      text = readFileSync(0, 'utf8'); // stdin
    }
  } catch (err) {
    process.stderr.write(`cc-check: 读取失败：${err?.message ?? err}\n`);
    return 2;
  }

  const result = checkContract(text);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const head = result.ok ? '✅ 变更契约校验通过' : '❌ 变更契约校验未通过';
    process.stdout.write(`${head}（分级 ${result.level ?? '未填'}，契约行 ${result.rows}）\n`);
    for (const e of result.errors) process.stdout.write(`  ❌ ${e}\n`);
    for (const w of result.warnings) process.stdout.write(`  ⚠️  ${w}\n`);
  }
  return result.ok ? 0 : 1;
}

const isDirectRun = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  process.exit(main(process.argv));
}
