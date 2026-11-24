import Ajv2020 from 'ajv/dist/2020.js';
import { readJson, policyPath } from './io.mjs';

// strictRequired is off because conditional `then: { required: [...] }` blocks reference properties defined
// at the parent level, which is valid JSON Schema; every other strict-mode rule stays on.
// strictTuples is off because a lint rule value is a variable-length tuple ([severity, ...options]).
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, strictTuples: false });
const cache = new Map();

/** Returns a validator for schemas/<name>.schema.json. */
export function validator(name) {
  if (!cache.has(name)) {
    const schema = readJson(policyPath('schemas', `${name}.schema.json`));
    try {
      cache.set(name, ajv.compile(schema));
    } catch (err) {
      ajv.removeSchema(schema.$id); // keep the instance usable after a failed compile
      throw new Error(`schema ${name} does not compile: ${err.message}`);
    }
  }
  return cache.get(name);
}

/** Validates data; returns a list of human-readable errors (empty when valid). */
export function validate(name, data) {
  const fn = validator(name);
  if (fn(data)) return [];
  return fn.errors.map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
}
