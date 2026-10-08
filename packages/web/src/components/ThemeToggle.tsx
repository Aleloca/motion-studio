import { useT } from '../i18n.tsx';
import type { Theme } from '../theme.ts';

// Superseded by the theme choice in Settings (Phase 7); removed in Task 16.
export { applyTheme } from '../theme.ts';

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
