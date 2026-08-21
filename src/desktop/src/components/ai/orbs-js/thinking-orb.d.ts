export type ThinkingOrbState =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping'

export interface ThinkingOrbOptions {
  state?: ThinkingOrbState
  size?: number
  speed?: number
  paused?: boolean
}

export declare class ThinkingOrb {
  constructor(canvas: HTMLCanvasElement, opts?: ThinkingOrbOptions)
  canvas: HTMLCanvasElement
  state: ThinkingOrbState
  size: number
  speedMul: number
  paused: boolean
  setState(state: ThinkingOrbState): void
  setTheme(isDark: boolean): void
  destroy(): void
}
