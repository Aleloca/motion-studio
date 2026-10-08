import type { WorkspaceSettings } from '@motion-studio/shared';
import { useT } from '../i18n.tsx';

type Theme = WorkspaceSettings['theme'];

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const THEMES: Theme[] = ['system', 'light', 'dark'];

export function ThemeToggle({ value, onChange }: { value: Theme; onChange: (t: Theme) => void }) {
  const t = useT();
  return (
    <div role="radiogroup" aria-label={t.web.theme.aria} className="row" style={{ gap: 4 }}>
      {THEMES.map((id) => (
        <button key={id} type="button" role="radio" aria-checked={value === id} className={value === id ? 'primary' : ''} onClick={() => onChange(id)}>
          {t.web.theme[id]}
        </button>
      ))}
    </div>
  );
}
