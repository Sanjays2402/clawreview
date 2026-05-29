export function BarChart({ data, height = 120 }: { data: number[]; height?: number }) {
  const max = Math.max(...data, 1);
  return (
    <div className="flex h-[var(--h)] items-end gap-1" style={{ ['--h' as any]: `${height}px` }}>
      {data.map((v, i) => (
        <div key={i} className="flex-1 rounded-t bg-accent/70" style={{ height: `${(v / max) * 100}%` }} />
      ))}
    </div>
  );
}
