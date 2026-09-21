#!/usr/bin/env node
/**
 * 同步 monorepo 核心包 → Cocos 工程（架构决策 A：预编译 + 同步）
 *
 * 做两件事：
 *  1) 把 engine / protocol / client-core 的 TS 源码同步到
 *     client/ac-majong/assets/scripts/vendor/<pkg>/，并把跨包 import
 *     （@ac-majong/xxx）重写为相对路径，使 Cocos 自带的 TS 编译可直接处理；
 *  2) 同步牌面素材 docs/2-效果图/.../res/tiles → assets/resources/tiles（供 resources.load）。
 *
 * 用法：pnpm sync:client
 */
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COCOS = join(ROOT, 'client/ac-majong');
const VENDOR = join(COCOS, 'assets/scripts/vendor');
const TILES_SRC = join(ROOT, 'docs/2-效果图/HTML格式高保真原型/res/tiles');
const TILES_DST = join(COCOS, 'assets/resources/tiles');

const PKGS = [
  { name: 'engine', src: join(ROOT, 'packages/engine/src') },
  { name: 'protocol', src: join(ROOT, 'packages/protocol/src') },
  { name: 'client-core', src: join(ROOT, 'packages/client-core/src') },
];

/** @ac-majong/engine → 相对路径（Cocos 无 workspace 解析） */
function rewriteImports(code, fileDir) {
  return code.replace(/(['"])@ac-majong\/([a-z-]+)\1/g, (_m, q, pkg) => {
    const target = join(VENDOR, pkg, 'index');
    let rel = relative(fileDir, target).split('\\').join('/');
    if (!rel.startsWith('.')) rel = './' + rel;
    return `${q}${rel}${q}`;
  });
}

function syncPkg({ name, src }) {
  const dst = join(VENDOR, name);
  // 原位更新生成源码，保留 Cocos .meta UUID；整目录重建会破坏已有资源引用。
  mkdirSync(dst, { recursive: true });
  let count = 0;
  for (const f of readdirSync(src)) {
    if (!f.endsWith('.ts')) continue;
    const code = readFileSync(join(src, f), 'utf8');
    writeFileSync(join(dst, f), rewriteImports(code, dst), 'utf8');
    count++;
  }
  console.log(`  ✓ ${name}: ${count} 个 .ts → assets/scripts/vendor/${name}/`);
}

function syncTiles() {
  if (!existsSync(TILES_SRC)) {
    console.log('  ⚠️ 未找到牌面素材目录，跳过');
    return;
  }
  mkdirSync(TILES_DST, { recursive: true });
  let n = 0;
  for (const f of readdirSync(TILES_SRC)) {
    if (!/\.(png|jpg|jpeg|webp)$/i.test(f)) continue;
    cpSync(join(TILES_SRC, f), join(TILES_DST, f));
    n++;
  }
  console.log(`  ✓ 素材: ${n} 张 → assets/resources/tiles/`);
}

if (!existsSync(COCOS)) {
  console.error(`✗ 未找到 Cocos 工程: ${COCOS}`);
  process.exit(1);
}
console.log('同步核心包与素材到 Cocos 工程...');
mkdirSync(VENDOR, { recursive: true });
PKGS.forEach(syncPkg);
syncTiles();
console.log('完成。Cocos 侧 import 示例：');
console.log("  import { GameClient, WebTransport } from './vendor/client-core/index';");
