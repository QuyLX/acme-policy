import { listCatalog } from '@console/catalog';

export async function catalogPanel(ctx, source, cache) {
  return (await listCatalog(ctx, source, cache)).map((i) => i.name).join(', ');
}
