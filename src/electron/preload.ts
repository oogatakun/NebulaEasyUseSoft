import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
    onUpdateStatus: (cb: (data: Record<string, unknown>) => void) =>
        ipcRenderer.on('update-status', (_e, data) => cb(data)),
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    getVersion: () => ipcRenderer.invoke('get-version')
})
