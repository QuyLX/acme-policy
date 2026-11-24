// Test preset entry point (FE §8.7 item 3). Plugins come from the product (e.g. @vitejs/plugin-react), because the
// test runtime resolves from the product's dependency graph; everything else comes from here.
const INCLUDE = ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'];
// Browser lanes run only under createVitestBrowserConfig; the jsdom run never picks them up.
const EXCLUDE = ['**/node_modules/**', '**/dist/**', '**/*.browser.test.{ts,tsx}', '**/*.visual.test.{ts,tsx}'];
export const BROWSER_INCLUDE = ['**/*.browser.test.{ts,tsx}', '**/*.visual.test.{ts,tsx}'];

/**
 * @param {{ kind: 'next-app'|'react-lib'|'node-lib', plugins?: unknown[], root?: string,
 *           test?: { environment?: 'node'|'jsdom', setupFiles?: string[], coverage?: { lines?: number } } }} input
 */
export function createVitestConfig({ kind, plugins = [], root, test = {} }) {
  if (!['next-app', 'react-lib', 'node-lib', 'node-tool'].includes(kind)) throw new Error(`@acme/presets: unknown project kind "${kind}"`);
  const config = {
    plugins,
    test: {
      environment: test.environment ?? (kind === 'node-lib' || kind === 'node-tool' ? 'node' : 'jsdom'),
      include: INCLUDE,
      exclude: EXCLUDE,
      setupFiles: test.setupFiles ?? [],
      passWithNoTests: false,
    },
  };
  if (root) config.root = root;
  // Conditions apply to Vite-resolved modules and to externalized node_modules (loaded by Node, not Vite).
  if (test.conditions?.length) {
    config.resolve = { conditions: test.conditions };
    config.ssr = { resolve: { conditions: test.conditions, externalConditions: test.conditions } };
  }
  if (test.coverage?.lines !== undefined) {
    config.test.coverage = { enabled: true, thresholds: { lines: test.coverage.lines } };
  }
  return config;
}

/**
 * Real-browser lanes (tech-design 07 §6b; D-21): `*.browser.test.*` (interaction + axe incl. color contrast) and
 * `*.visual.test.*` (screenshots; baselines `__screenshots__/<file>/<name>-chromium-<platform>.png`). The provider
 * comes from the product install (pinned by meta.toolchain-pin), like the React plugin.
 * @param {{ kind: string, plugins?: unknown[], provider: unknown, root?: string }} input
 */
export function createVitestBrowserConfig({ kind, plugins = [], provider, root }) {
  if (!['react-lib', 'next-app'].includes(kind)) throw new Error(`@acme/presets: browser lanes need a React project, got "${kind}"`);
  const config = {
    plugins,
    test: {
      include: BROWSER_INCLUDE,
      exclude: ['**/node_modules/**', '**/dist/**'],
      passWithNoTests: false,
      browser: {
        enabled: true,
        headless: true,
        provider,
        instances: [{ browser: 'chromium' }],
        screenshotFailures: false,
        expect: { toMatchScreenshot: { comparatorName: 'pixelmatch', comparatorOptions: { allowedMismatchedPixelRatio: 0 } } },
      },
    },
  };
  if (root) config.root = root;
  return config;
}
