export const overall = (services) => (services.every((s) => s.ok) ? 'operational' : 'degraded');
