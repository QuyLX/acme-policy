// Non-React libraries and build scripts (e.g. @platform/ds-tokens): TypeScript rules.
import tseslint from 'typescript-eslint';

export default [{ ignores: ['dist/**'] }, ...tseslint.configs.recommended];
