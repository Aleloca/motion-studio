export type Risk = 'low' | 'medium' | 'high';

export type IndicatorId =
  | 'deletes-files'
  | 'installs-packages'
  | 'uses-network'
  | 'kills-processes'
  | 'writes-outside-project'
  | 'reads-outside-project'
  | 'runs-code'
  | 'elevated'
  | 'changes-git'
  | 'complex'
  | 'unknown-command'
  | 'outside-sandbox';

/** Rendered from the i18n catalogs: `key` is a catalog key, `params` fill its placeholders. */
export interface Phrase { key: string; params: Record<string, string | number> }

export interface Indicator { id: IndicatorId; risk: Risk; params?: Record<string, string> }

export interface Explanation {
  /** One phrase per simple command, in order (max 6, then "and N more steps"). */
  summary: Phrase[];
  /** De-duplicated, sorted by risk. */
  indicators: Indicator[];
  risk: Risk;
  /** False when the command could not be analyzed reliably. */
  parsed: boolean;
}
