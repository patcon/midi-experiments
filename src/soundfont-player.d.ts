declare module 'soundfont-player' {
  export interface Instrument {
    play(
      note: number | string,
      when?: number,
      options?: { gain?: number; duration?: number; loop?: boolean },
    ): { stop(when?: number): void }
    stop(when?: number): void
    disconnect(): void
  }
  export function instrument(
    ac: AudioContext,
    name: string,
    options?: { format?: string; soundfont?: string },
  ): Promise<Instrument>
}
