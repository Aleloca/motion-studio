import { describe, expect, it } from 'vitest';
import { absoluteLinks } from '../scripts/readme-links.ts';

const BLOB = 'https://github.com/Aleloca/motion-studio/blob/main';

describe('README links for the npm page', () => {
  it('makes relative links absolute (on npm they would point nowhere)', () => {
    const md = 'Vedi [CONTRIBUTING.md](CONTRIBUTING.md), [provider](docs/providers.md#chiavi), [licenza](./LICENSE).';
    expect(absoluteLinks(md)).toBe(`Vedi [CONTRIBUTING.md](${BLOB}/CONTRIBUTING.md), [provider](${BLOB}/docs/providers.md#chiavi), [licenza](${BLOB}/LICENSE).`);
  });
  it('leaves absolute URLs, anchors, mail links and code alone', () => {
    const md = '[sito](https://nodejs.org) [su](#requisiti) [mail](mailto:a@b.c) `docs/providers.md`';
    expect(absoluteLinks(md)).toBe(md);
  });
});
