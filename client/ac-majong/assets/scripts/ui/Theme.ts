import { Color } from 'cc';

/**
 * 设计令牌（Design Tokens）——1:1 移植自
 * docs/2-效果图/HTML格式高保真原型/style.css 的 :root。
 * 风格：传统中式（红木质感 + 金色边框 + 深绿桌布）。
 * 所有 UI 组件（UiKit）与页面都应引用这里，保证视觉一致、便于统一调整。
 */
const c = (r: number, g: number, b: number, a = 255): Color => new Color(r, g, b, a);

export const Theme = {
  color: {
    // === 主色调 ===
    bgTable: c(13, 74, 42), // #0d4a2a 深绿桌布
    bgTableDark: c(9, 61, 34), // #093d22
    bgWood: c(61, 31, 13), // #3d1f0d 红木
    bgWoodDark: c(42, 20, 8), // #2a1408
    bgPanel: c(0, 0, 0, 115), // rgba(0,0,0,.45) 半透明面板
    bgCard: c(61, 31, 13, 217), // rgba(61,31,13,.85) 木纹卡片
    // === 金色系 ===
    gold: c(212, 165, 55), // #d4a537
    goldLight: c(232, 199, 107), // #e8c76b
    goldDark: c(160, 125, 28), // #a07d1c
    goldGlow: c(212, 165, 55, 77), // rgba(...,.3)
    goldFaint: c(212, 165, 55, 51), // rgba(...,.2) 常见描边
    goldHairline: c(212, 165, 55, 38), // rgba(...,.15)
    // === 牌面 ===
    tileFace: c(255, 254, 245), // #fffef5 象牙白
    tileBorder: c(139, 115, 85), // #8b7355
    tileWan: c(196, 30, 58), // 万-红
    tileTong: c(26, 110, 216), // 筒-蓝
    tileTiao: c(26, 103, 71), // 条-绿
    tileWind: c(26, 26, 46), // 风/字-黑
    // === 文字 ===
    textPrimary: c(245, 230, 200), // #f5e6c8 暖白
    textSecondary: c(184, 160, 120), // #b8a078
    textMuted: c(122, 106, 82), // #7a6a52
    textDark: c(42, 26, 10), // #2a1a0a 浅底上的深字
    // === 功能色 ===
    success: c(76, 175, 80),
    warning: c(255, 152, 0),
    danger: c(244, 67, 54),
    info: c(33, 150, 243),
    // === 其它 ===
    wxGreen: c(7, 193, 96), // 微信品牌绿（登录按钮）
    wxGreenDark: c(6, 160, 80),
    white: c(255, 255, 255),
    mask: c(0, 0, 0, 166), // rgba(0,0,0,.65) 弹层遮罩
  },
  // 间距
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 },
  // 圆角
  radius: { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 },
  // 尺寸
  size: {
    tileW: 42,
    tileH: 58,
    tileRadius: 5,
    tileFont: 20,
    tileGap: 2,
    headerH: 48,
    tabH: 56,
    designW: 844, // 设计分辨率（横屏）
    designH: 390,
  },
  // 字号规范（对齐 style.css；Cocos Label 用系统字体）
  font: {
    hero: 30, // 登录主标题
    h2: 28, // 大厅主标题
    title: 18, // 弹层标题
    body: 14,
    small: 12,
    tiny: 11,
    mini: 10,
  },
};

/** 半透明黑（用于遮罩/压暗），a∈[0,1] */
export function rgba(r: number, g: number, b: number, a: number): Color {
  return new Color(r, g, b, Math.round(a * 255));
}
