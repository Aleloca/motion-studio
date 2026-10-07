import type { WorkspaceSettings } from '@motion-studio/shared';

type Theme = WorkspaceSettings['theme'];

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const LABELS: Record<Theme, string> = { system: 'Sistema', light: 'Chiaro', dark: 'Scuro' };

export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  return (
    <div role="radiogroup" aria-label="Tema" className="row" style={{ gap: 4 }}>
      {(Object.keys(LABELS) as Theme[]).map((t) => (
        <button key={t} type="button" role="radio" aria-checked={value === t} className={value === t ? 'primary' : ''} onClick={() => onChange(t)}>
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}
