import type { Linter } from 'eslint';

export type ProjectKind = 'next-app' | 'react-lib' | 'node-lib' | 'node-tool';
export interface EslintPresetInput {
  kind: ProjectKind;
  boundaries?: boolean;
  lint?: { rules?: Linter.RulesRecord; ignores?: string[] };
}
export function createEslintConfig(input: EslintPresetInput): Linter.Config[];
