// "Replace…": the asset picker for one file of a clip (its source, or an html layer's image parameter). Picking stages the
// library file with the current preview session (the draft store's helper; a large video shows the busy state meanwhile), and
// hands the staged file to the caller, which edits the draft with its path. The picker closes once the caller has.
import type { AssetEntry, AssetKind, StagedAsset } from '@motion-studio/shared';
import { useState } from 'react';
import { useT } from '../../../i18n.tsx';
import { Button, Icon } from '../../../ui/index.ts';
import { AssetPicker } from '../AssetPicker.tsx';
import { useEditor } from '../editorContext.ts';

export function ReplaceFile({ kinds, current, disabled, describedBy, onStaged }: {
  kinds: readonly AssetKind[]; current: string; disabled?: boolean; describedBy?: string; onStaged(staged: StagedAsset): void;
}) {
  const e = useT().web.editor;
  const { stageAsset } = useEditor();
  const [open, setOpen] = useState(false);
  const pick = async (entry: AssetEntry) => {
    const staged = await stageAsset({ kind: 'library', file: entry.file });
    if (!staged) return;
    onStaged(staged);
    setOpen(false);
  };
  return (
    <div className="ms-insp-file">
      <span className="ms-insp-path" title={current}>{current.split('/').pop()}</span>
      <Button size="sm" variant="outline" disabled={disabled} aria-describedby={describedBy} onClick={() => setOpen(true)}><Icon name="image" size={13} />{e.replace}</Button>
      <AssetPicker open={open} onClose={() => setOpen(false)} kinds={kinds} onPick={pick} />
    </div>
  );
}
