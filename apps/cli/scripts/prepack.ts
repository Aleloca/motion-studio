// Copies README.md (with absolute links) and LICENSE from the repository root into the npm package.
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { absoluteLinks } from './readme-links.ts';

writeFileSync('README.md', absoluteLinks(readFileSync('../../README.md', 'utf8')));
copyFileSync('../../LICENSE', 'LICENSE');
