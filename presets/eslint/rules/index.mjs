// @acme ESLint plugin: profile rules from the FE rule catalog (FE §4.5) that no off-the-shelf plugin covers.
import noHardcodedDesignValues from './no-hardcoded-design-values.mjs';
import noRawInteractiveElements from './no-raw-interactive-elements.mjs';
import noPrivateModuleImport from './no-private-module-import.mjs';
import noAppImportInPackage from './no-app-import-in-package.mjs';
import noEffectFetch from './no-effect-fetch.mjs';
import noRawServiceFetch from './no-raw-service-fetch.mjs';
import serverOnlyClients from './server-only-clients.mjs';
import wrappedServerActions from './wrapped-server-actions.mjs';
import noDirectDataCache from './no-direct-data-cache.mjs';
import tenantQueryKey from './tenant-query-key.mjs';
import csvSafeExport from './csv-safe-export.mjs';

export default {
  meta: { name: '@acme/eslint-plugin', version: '1.0.0' },
  rules: {
    'no-hardcoded-design-values': noHardcodedDesignValues, // FE-DS-001
    'no-raw-interactive-elements': noRawInteractiveElements, // FE-UX-001
    'no-private-module-import': noPrivateModuleImport, // FE-ARCH-001
    'no-app-import-in-package': noAppImportInPackage, // FE-ARCH-006
    'no-effect-fetch': noEffectFetch, // FE-STATE-002
    'no-raw-service-fetch': noRawServiceFetch, // FE-API-001
    'server-only-clients': serverOnlyClients, // FE-NEXT-001
    'wrapped-server-actions': wrappedServerActions, // FE-NEXT-002
    'no-direct-data-cache': noDirectDataCache, // FE-NEXT-005
    'tenant-query-key': tenantQueryKey, // FE-CTX-001
    'csv-safe-export': csvSafeExport, // FE §8.4 cap:import-export (export.csv-injection); not in any PROFILE_RULES kind yet
  },
};
