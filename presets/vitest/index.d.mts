import type { ProjectKind } from '../eslint/index.d.mts';

export interface VitestPresetInput {
  kind: ProjectKind;
  plugins?: unknown[];
  root?: string;
  test?: { environment?: 'node' | 'jsdom'; setupFiles?: string[]; coverage?: { lines?: number }; browser?: { tailwind?: boolean; visual?: boolean }; conditions?: Array<'react-server'> };
}
// Returns a Vitest user config object (the shape `defineConfig` accepts).
export function createVitestConfig(input: VitestPresetInput): Record<string, unknown>;
export const BROWSER_INCLUDE: string[];
export function createVitestBrowserConfig(input: { kind: ProjectKind; plugins?: unknown[]; provider: unknown; root?: string }): Record<string, unknown>;
