export function Avatar({ login, src, size = 28 }: { login: string; src?: string; size?: number }) {
  return src ? (
    <img src={src} alt={login} width={size} height={size} className="rounded-full border border-border" />
  ) : (
    <div className="grid place-items-center rounded-full bg-bg-subtle text-xs font-medium text-fg-muted" style={{ width: size, height: size }}>
      {login.slice(0, 2).toUpperCase()}
    </div>
  );
}
