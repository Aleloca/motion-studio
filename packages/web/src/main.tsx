import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './theme.css';
import './ui/ui.css';
import { captureUiToken, listenForUiToken } from './uiToken.ts';

// Before any routing or API call: the terminal link carries the UI token in the fragment (also when pasted later).
captureUiToken();
listenForUiToken();

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
