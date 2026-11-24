export type ChipTone = 'neutral' | 'info';
export interface ChipProps {
  /** Visible text. */
  label: string;
  tone?: ChipTone;
}
export function Chip(props: ChipProps): string {
  return `${props.tone ?? 'neutral'}:${props.label}`;
}
