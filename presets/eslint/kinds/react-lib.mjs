// React libraries (e.g. @platform/ds-react): TypeScript, hooks and a11y.
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

export default [
  { ignores: ['dist/**', 'storybook-static/**'] },
  ...tseslint.configs.recommended,
  reactHooks.configs.flat['recommended-latest'] ?? reactHooks.configs.flat.recommended,
  jsxA11y.flatConfigs.recommended,
];
