// The parameters an html layer declares (`params`): one field per parameter by its type. An `image` parameter takes a library
// image through the asset picker (staged first); the layer's own file is never edited here.
import type { Clip } from '@motion-studio/shared';
import { COMPOSITION_LIMITS } from '@motion-studio/shared';
import { useT } from '../../../i18n.tsx';
import { ColorField, Input, NumberField } from '../../../ui/index.ts';
import { Row, Section, type Ctl } from './common.tsx';
import { colorGroups } from './colors.ts';
import { ReplaceFile } from './ReplaceFile.tsx';

export function ParamsSection({ ctl }: { ctl: Ctl }) {
  const e = useT().web.editor;
  const clip = ctl.clip as Extract<Clip, { type: 'html' }>;
  const entries = Object.entries(clip.params ?? {});
  if (entries.length === 0) return null;
  const put = (key: string, value: string | number, coalesce?: string) => ctl.run(`param:${key}`, { kind: 'htmlParam', clipId: clip.id, key, value }, coalesce);
  return (
    <Section title={e.secParams} name="params">
      {entries.map(([key, param]) => {
        const field = `param:${key}`;
        const label = param.label ?? key;
        const bad = ctl.problems(field, [key]).length > 0;
        const coalesce = `insp:${clip.id}:${field}`;
        return (
          <Row key={key} ctl={ctl} field={field} fields={[key]}>
            <div className="ms-insp-param">
              <span className="ms-insp-cap">{label}</span>
              {param.type === 'text' ? (
                <Input aria-label={label} value={param.value} maxLength={COMPOSITION_LIMITS.text} disabled={ctl.locked} aria-invalid={bad || undefined} aria-describedby={ctl.errId(field)}
                  onChange={(ev) => put(key, ev.target.value, coalesce)} onBlur={ctl.end} />
              ) : param.type === 'number' ? (
                <NumberField label={label} value={param.value} min={-1e9} max={1e9} step={1} disabled={ctl.locked} invalid={bad} describedBy={ctl.errId(field)}
                  onChange={(v) => put(key, v, coalesce)} onEnd={ctl.end} />
              ) : param.type === 'color' ? (
                <ColorField label={label} value={param.value} disabled={ctl.locked} invalid={bad} describedBy={ctl.errId(field)} groups={colorGroups(e, ctl)}
                  onChange={(hex) => put(key, hex, coalesce)} onEnd={ctl.end} />
              ) : (
                <ReplaceFile kinds={['image', 'svg']} current={param.value} disabled={ctl.locked} describedBy={ctl.errId(field)}
                  onStaged={(s) => { put(key, s.path); ctl.end(); }} />
              )}
            </div>
          </Row>
        );
      })}
    </Section>
  );
}
