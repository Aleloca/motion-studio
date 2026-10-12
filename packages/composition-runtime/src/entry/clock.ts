import { installVirtualClock } from '../clock.ts';

// dist/clock.js: the virtual clock alone, for Page.addScriptToEvaluateOnNewDocument (render mode, every frame).
installVirtualClock(window);
