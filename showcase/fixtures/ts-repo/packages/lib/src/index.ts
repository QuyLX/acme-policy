// Seeded lint violation (@typescript-eslint/no-explicit-any) for showcase scenarios; type-checks cleanly.
export function describeValue(input: any): string {
  return String(input);
}
