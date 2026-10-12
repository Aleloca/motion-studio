import { startRuntime } from '../runtime-main.ts';

// dist/runtime.js: the only script of dist/index.html.
Object.defineProperty(window, '__ms', { value: startRuntime(window), writable: false, configurable: false });
