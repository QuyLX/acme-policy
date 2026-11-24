// Module boundaries enforced by Nx tags (FE §3.3 option B, §4.4). Tags live in each package.json `nx.tags`
// (a control file); scope:* = which product a project belongs to, type:* = what kind of project it is.
import nx from '@nx/eslint-plugin';

export default [
  {
    plugins: { '@nx': nx },
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          allow: [],
          depConstraints: [
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:lib', 'type:config'] },
            { sourceTag: 'type:lib', onlyDependOnLibsWithTags: ['type:lib', 'type:config'] },
            { sourceTag: 'scope:console', onlyDependOnLibsWithTags: ['scope:console', 'scope:shared'] },
            { sourceTag: 'scope:admin', onlyDependOnLibsWithTags: ['scope:admin', 'scope:shared'] },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
          ],
        },
      ],
    },
  },
];
