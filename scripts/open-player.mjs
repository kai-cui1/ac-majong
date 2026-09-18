#!/usr/bin/env node
/**
 * open-player.mjs — 启动「全新独立浏览器窗口」（手动登录版，2026-09-18 应用户要求移除自动登录）。
 * 每次运行使用独立临时 profile（localStorage/会话完全隔离、无残留会话免密复登），
 * 只负责把窗口开起来；登录/注册/加入房间全部由用户在窗口内手动完成。
 *
 * 用法：
 *   node scripts/open-player.mjs [窗口名] [--port N] [--page url]
 * 示例：
 *   node scripts/open-player.mjs                 # 开一个独立窗口（默认编辑器预览站 7456）
 *   node scripts/open-player.mjs seat2           # 窗口名 seat2（仅临时目录前缀与日志标识）
 *   node scripts/open-player.mjs --port 8081     # 指向构建产物静态站
 *
 * 约定：脚本开窗后立即退出，浏览器继续运行；多真人同房需服务端 AUTO_BOTS=0。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('用法: node scripts/open-player.mjs [窗口名] [--port N] [--page url]（默认端口 7456 编辑器预览站）');
  process.exit(0);
}
let port = 7456;
const pi = argv.indexOf('--port');
if (pi >= 0) {
  if (!/^[0-9]+$/.test(argv[pi + 1] ?? '')) {
    console.error('--port 需为数字端口');
    process.exit(2);
  }
  port = Number(argv[pi + 1]);
}
let page = `http://127.0.0.1:${port}/`; // 预览站与静态站根路径均服务入口页
const gi = argv.indexOf('--page');
if (gi >= 0 && argv[gi + 1]) page = argv[gi + 1];
// 位置参数（排除 --port/--page 的取值）= 窗口名，仅用于临时目录前缀与日志标识
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i === pi + 1 && pi >= 0) && !(i === gi + 1 && gi >= 0));
const label = (pos[0] ?? 'manual').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 24);

// ---------- 全新临时 profile（每次运行隔离，无残留登录态） ----------
const profile = fs.mkdtempSync(path.join(os.tmpdir(), `ac-player-${label}-`));

const chrome = spawn(
  CHROME,
  [`--user-data-dir=${profile}`, '--window-size=1280,720', '--hide-scrollbars', page],
  { detached: true, stdio: 'ignore' },
);
chrome.unref();
console.log(`[open-player] 已启动全新独立窗口：窗口名=${label} page=${page}`);
console.log(`[open-player] profile=${profile} chromePid=${chrome.pid}`);
console.log('[open-player] 请在新窗口内手动登录/注册；脚本已退出，浏览器保持运行。');
process.exit(0);
