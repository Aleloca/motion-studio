import { startLayerAgent } from '../layer-agent.ts';

// dist/layer.js: injected by the core as the first script of every html layer (page.ts, injectLayerBootstrap).
startLayerAgent(window);
