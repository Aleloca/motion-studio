import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Under full-suite load (every workspace project in parallel) the default
// 1 s waitFor/findBy timeout is too tight for heavier screens such as the
// format view. Fake-timer tests are unaffected: they advance time explicitly.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());
