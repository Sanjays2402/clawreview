import type { SVGProps } from 'react';

export function SearchIcon({ size = 18, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <title>Search</title>
      <rect x="3" y="3" width="18" height="18" rx="3" opacity={0.25} />
      <path d="M7 12h10M12 7v10" />
    </svg>
  );
}
