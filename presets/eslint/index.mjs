// Lint preset entry point (FE §8.7 item 3). Product repos never hand-write lint config: `factory sync` generates a
// file that calls createEslintConfig() with the project's kind and its factory.config.yaml overrides (FE-CFG-001).
import nextApp from './kinds/next-app.mjs';
import reactLib from './kinds/react-lib.mjs';
import nodeLib from './kinds/node-lib.mjs';
import boundaries from './boundaries.mjs';
import acme from './rules/index.mjs';
import jsxA11y from 'eslint-plugin-jsx-a11y';

// Profile rules (FE §4.5) per project kind. Apps get the strict a11y set; the DS builds controls on React Aria, so
// it is exempt from the raw-interactive rule (it is the place those controls are made).
const PROFILE_RULES = {
  'next-app': {
    '@acme/no-hardcoded-design-values': 'error',
    '@acme/no-raw-interactive-elements': 'error',
    '@acme/no-private-module-import': 'error',
    '@acme/no-effect-fetch': 'error',
    '@acme/no-raw-service-fetch': 'error',
    '@acme/server-only-clients': 'error',
    '@acme/wrapped-server-actions': 'error',
    '@acme/no-direct-data-cache': 'error',
    '@acme/tenant-query-key': 'error',
    ...jsxA11y.flatConfigs.strict.rules,
  },
  'react-lib': {
    '@acme/no-hardcoded-design-values': 'error',
    '@acme/no-app-import-in-package': 'error',
    '@acme/no-effect-fetch': 'error',
    '@acme/no-direct-data-cache': 'error',
    '@acme/tenant-query-key': 'error',
  },
  'node-lib': { '@acme/no-app-import-in-package': 'error', '@acme/no-direct-data-cache': 'error' },
  'node-tool': { '@acme/no-app-import-in-package': 'error' },
};

const KINDS = { 'next-app': nextApp, 'react-lib': reactLib, 'node-lib': nodeLib, 'node-tool': nodeLib };

/**
 * @param {{ kind: 'next-app'|'react-lib'|'node-lib'|'node-tool', boundaries?: boolean, lint?: { rules?: Record<string, unknown>, ignores?: string[] } }} input
 */
export function createEslintConfig({ kind, boundaries: withBoundaries = true, lint = {} }) {
  const base = KINDS[kind];
  if (!base) throw new Error(`@acme/presets: unknown project kind "${kind}"`);
  const config = [{ ignores: ['node_modules/**'] }, ...base];
  config.push({ plugins: { '@acme': acme }, rules: PROFILE_RULES[kind] });
  if (withBoundaries) config.push(...boundaries);
  if (lint.ignores?.length) config.push({ ignores: lint.ignores });
  if (lint.rules && Object.keys(lint.rules).length) config.push({ rules: lint.rules });
  return config;
}
