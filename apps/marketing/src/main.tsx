import React from 'react';
import ReactDOM from 'react-dom/client';
import '@enoughtools/ui-react/styles.css';
import './styles.css';
import { App } from './App';
import releaseJson from '../public/downloads/manifest.json';
import { parseReleaseManifest } from './releases';

const root = document.getElementById('root')!;
const application = <React.StrictMode><App initialManifest={parseReleaseManifest(releaseJson)} /></React.StrictMode>;
if (root.hasChildNodes()) ReactDOM.hydrateRoot(root, application);
else ReactDOM.createRoot(root).render(application);
