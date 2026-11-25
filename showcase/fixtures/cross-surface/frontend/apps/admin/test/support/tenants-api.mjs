// The tenants-api a journey talks to (synthetic; FE §8.8).
// - Without STAGING_STANDIN_DIR: the in-memory scenario fixture (mock layer, deterministic).
// - With STAGING_STANDIN_DIR: a stand-in for the staging tenants-api, set up by the SC-17 scenario runner because no
//   staging exists. The directory holds the environment's health document (health.json, the document the
//   environment health probe reads) and optionally a recorded outage (outage.json: { service, fromRequest, detail }).
//   Every request checks the service's health; when the outage starts, the stand-in marks the service unhealthy in
//   health.json (as a real environment's status endpoint would report it) and answers 503.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVICE = 'tenants-api';

export function tenantsApi(inMemory) {
  const dir = process.env.STAGING_STANDIN_DIR;
  if (!dir) return inMemory;
  const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));
  return {
    async listUsers(tenantId) {
      const health = read('health.json');
      const service = health.services.find((s) => s.name === SERVICE);
      const count = (existsSync(join(dir, 'requests.json')) ? read('requests.json')[SERVICE] ?? 0 : 0) + 1;
      writeFileSync(join(dir, 'requests.json'), JSON.stringify({ [SERVICE]: count }));
      const outage = existsSync(join(dir, 'outage.json')) ? read('outage.json') : null;
      if (outage?.service === SERVICE && count >= outage.fromRequest && service.health === 'healthy') {
        Object.assign(service, { health: 'unhealthy', detail: outage.detail });
        writeFileSync(join(dir, 'health.json'), JSON.stringify(health, null, 2));
      }
      if (service.health !== 'healthy') throw new Error(`${SERVICE} 503 Service Unavailable (${service.detail ?? service.health})`);
      return inMemory.listUsers(tenantId);
    },
  };
}
