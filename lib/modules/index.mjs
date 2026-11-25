// Merges the module groups of tech-design 13. A duplicate kind or checkId across groups is a programming error.
import * as verificationCore from './verification-core.mjs';
import * as knowledge from './knowledge.mjs';
import * as governance from './governance.mjs';
import * as product from './product.mjs';

function merge(field) {
  const out = {};
  for (const [group, mod] of Object.entries({ verificationCore, knowledge, governance, product })) {
    for (const [key, fn] of Object.entries(mod[field])) {
      if (key in out) throw new Error(`lib/modules: ${field} "${key}" is defined twice (second in ${group})`);
      out[key] = fn;
    }
  }
  return out;
}

export const MODULE_KINDS = merge('KINDS');
export const MODULE_CHECKS = merge('CHECKS');
