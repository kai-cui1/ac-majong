import { AudioClip, AudioSource, Node, director, resources, sys } from 'cc';

/**
 * AudioManager —— 音频子系统单例（BL-014 游戏音效）。
 * 只做音效（SFX），不做 BGM。封装 Cocos AudioSource：
 * - SFX 用 playOneShot 播放，天然支持并发（多家连续出牌/响应叠加）；
 * - resources 懒加载 + Map 缓存；加载失败静默降级（缺素材不阻断对局）；
 * - 静音偏好持久化到 sys.localStorage（key ac_muted），启动读取沿用。
 * 设计见 docs/3-技术文档《前端基座与设计系统》§12；事件→音效映射见 PRD 07 §3.2.1。
 */

/** 全部音效资源名（对应 assets/resources/audio/<name>.mp3） */
export type SfxName =
  // 牌张拟音
  | 'discard' | 'draw' | 'flower' | 'deal'
  // 番种中文语音
  | 'chi' | 'pong' | 'kong_exposed' | 'kong_concealed' | 'kong_added' | 'win' | 'zhahu' | 'exhaustive'
  // 系统 / UI
  | 'click' | 'alert' | 'countdown' | 'settle';

const MUTE_KEY = 'ac_muted';

export class AudioManager {
  private static _inst: AudioManager | null = null;
  static get instance(): AudioManager {
    if (!this._inst) this._inst = new AudioManager();
    return this._inst;
  }

  private src: AudioSource | null = null;
  private cache = new Map<string, AudioClip>();
  private _muted = false;

  private constructor() {
    try {
      this._muted = sys.localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      /* 读取失败则默认不静音 */
    }
  }

  get muted(): boolean {
    return this._muted;
  }

  /** 设置静音并持久化偏好 */
  setMuted(muted: boolean): void {
    this._muted = muted;
    try {
      sys.localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
    } catch {
      /* 写入失败则仅本次生效 */
    }
  }

  /** 切换静音，返回切换后的静音态（供 UI 刷新图标） */
  toggleMuted(): boolean {
    this.setMuted(!this._muted);
    return this._muted;
  }

  /** 播放一条音效；静音或素材缺失时静默跳过 */
  play(name: SfxName): void {
    if (this._muted) return;
    const cached = this.cache.get(name);
    if (cached) {
      this.emit(cached);
      return;
    }
    resources.load(`audio/${name}`, AudioClip, (err, clip) => {
      if (err || !clip) return; // 静默降级：缺素材不抛错、不阻断对局
      this.cache.set(name, clip);
      if (!this._muted) this.emit(clip);
    });
  }

  private emit(clip: AudioClip): void {
    const src = this.ensureSource();
    if (src) src.playOneShot(clip, 1);
  }

  /** 懒建常驻 AudioSource 节点（挂到当前场景根，单 Canvas 多屏架构下一直存活） */
  private ensureSource(): AudioSource | null {
    if (this.src && this.src.isValid) return this.src;
    const scene = director.getScene();
    if (!scene) return null;
    const node = new Node('AudioManagerSfx');
    scene.addChild(node);
    this.src = node.addComponent(AudioSource);
    return this.src;
  }
}
