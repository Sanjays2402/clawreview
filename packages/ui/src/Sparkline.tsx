import { cn } from './cn.js';

export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
  strokeClassName?: string;
}

export function Sparkline({ data, width = 120, height = 32, className, strokeClassName }: SparklineProps) {
  if (data.length === 0) {
    return <svg width={width} height={height} className={cn('text-fg-muted', className)} />;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const stepX = data.length === 1 ? 0 : width / (data.length - 1);
  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * (height - 2) - 1;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} className={cn('text-accent', className)} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className={strokeClassName}
      />
    </svg>
  );
}
