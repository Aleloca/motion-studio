// The note of a comment on a clip or a time range (Phase 10b, Task 10): a small dialog over the editor. The note is optional
// (the clip or the range is the comment); ⌘/Ctrl+Enter adds it. Nothing is sent: the comment becomes a chip in the conversation.
import { useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n.tsx';
import { isSubmitChord } from '../../motion/index.ts';
import { Button, Modal, Textarea } from '../../ui/index.ts';

export function PinNoteDialog({ open, title, initial, adding, onSubmit, onCancel }: {
  open: boolean; title: string; initial: string; adding: boolean; onSubmit(note: string): void; onCancel(): void;
}) {
  const c = useT().web.conversation;
  const [text, setText] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) setText(initial); }, [open, initial]);
  useEffect(() => { if (open) field.current?.focus({ preventScroll: true }); }, [open]);
  return (
    <Modal open={open} onClose={onCancel} label={title} width={440}>
      <div className="ms-ed-dialog">
        <h2>{title}</h2>
        <Textarea ref={field} rows={4} maxLength={2000} aria-label={c.noteLabel} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (isSubmitChord(e.nativeEvent) && !e.repeat) { e.preventDefault(); onSubmit(text.trim()); } }} />
        <div className="ms-ed-dialog-foot">
          <Button variant="ghost" onClick={onCancel}>{c.noteCancel}</Button>
          <Button variant="ink" onClick={() => onSubmit(text.trim())}>{adding ? c.noteAdd : c.noteSave}</Button>
        </div>
      </div>
    </Modal>
  );
}
