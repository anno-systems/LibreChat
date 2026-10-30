import type { TLocation } from 'librechat-data-provider';
import { useHostingText } from '../hosting';

/** Fork: the second line of a vendor-grouped model's row, naming where it runs. */
export default function ModelHosting({ label, location }: { label: string; location?: TLocation }) {
  const hostingText = useHostingText();
  return (
    <span className="text-text-secondary block truncate text-xs" data-testid="model-hosting">
      {hostingText(label, location)}
    </span>
  );
}
