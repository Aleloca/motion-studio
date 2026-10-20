import { useT } from '../../i18n.tsx';
import { Button, Modal } from '../../ui/index.ts';

/**
 * Decision 1422: New creative opens on an idle brief session that already has messages: resume it (the form and the chat come
 * back, in "Con l'agente") or start over (the session is deleted). A choice is required: Esc and the scrim do nothing.
 */
export function ResumeBriefDialog({ open, onResume, onStartOver }: { open: boolean; onResume(): void; onStartOver(): void }) {
  const b = useT().web.briefSession;
  return (
    <Modal open={open} onClose={() => {}} label={b.resumeTitle} width={460} dismissible={false}>
      <div className="ms-brief-resume">
        <h2>{b.resumeTitle}</h2>
        <p>{b.resumeBody}</p>
        <div className="ms-brief-resume-actions">
          <Button variant="ghost" onClick={onStartOver}>{b.startOver}</Button>
          <Button variant="ink" autoFocus onClick={onResume}>{b.resume}</Button>
        </div>
      </div>
    </Modal>
  );
}
