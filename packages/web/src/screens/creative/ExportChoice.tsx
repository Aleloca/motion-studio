// Report 46: in a creative with a store pack and formats outside it, the top bar's Export first asks what to export: the
// store pack (its own export: store folders and store checks) or the format files (the ★ versions' export).
import { useT } from '../../i18n.tsx';
import { ChannelMark, Icon, Modal } from '../../ui/index.ts';
import '../canvas.css';

export function ExportChoice({ open, onClose, onPack, onFormats }: { open: boolean; onClose(): void; onPack(): void; onFormats(): void }) {
  const t = useT();
  const x = t.web.storePack.exportChoice;
  return (
    <Modal open={open} onClose={onClose} label={x.title} width={440}>
      <div className="ms-exp">
        <div className="ms-exp-head">
          <div className="ms-exp-titles"><h2>{x.title}</h2></div>
        </div>
        <div className="ms-exp-choice">
          <button type="button" className="ms-exp-choice-opt" onClick={onPack}>
            <span className="ms-exp-choice-icon" aria-hidden="true"><ChannelMark channel="appstore" /><ChannelMark channel="googleplay" /></span>
            <span className="ms-exp-choice-text"><b>{x.pack}</b><span>{x.packHint}</span></span>
          </button>
          <button type="button" className="ms-exp-choice-opt" onClick={onFormats}>
            <span className="ms-exp-choice-icon" aria-hidden="true"><Icon name="download" size={16} strokeWidth={1.6} /></span>
            <span className="ms-exp-choice-text"><b>{x.formats}</b><span>{x.formatsHint}</span></span>
          </button>
        </div>
      </div>
    </Modal>
  );
}
