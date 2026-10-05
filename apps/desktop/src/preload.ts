import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('enoughFactory', Object.freeze({
  platform: process.platform,
  getConnection: () => ipcRenderer.invoke('factory:connection'),
  pickDirectory: () => ipcRenderer.invoke('factory:directory'),
  openExternal: (url: string) => ipcRenderer.invoke('factory:external', url),
  openPreview: (options: unknown) => ipcRenderer.invoke('factory:preview-open', options),
  closePreview: () => ipcRenderer.invoke('factory:preview-close'),
  setPreviewBounds: (bounds: unknown) => ipcRenderer.invoke('factory:preview-bounds', bounds),
  previewNavigation: (action: 'back' | 'forward' | 'reload') => ipcRenderer.invoke('factory:preview-navigation', action),
  onPreviewStatus: (callback: (status: unknown) => void) => {
    const listener = (_event: unknown, status: unknown) => callback(status);
    ipcRenderer.on('factory:preview-status', listener);
    return () => ipcRenderer.removeListener('factory:preview-status', listener);
  },
  shutdownService: () => ipcRenderer.invoke('factory:service-shutdown'),
}));
