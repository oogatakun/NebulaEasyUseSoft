const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
    getVersion: () => ipcRenderer.invoke('get-version'),
    checkForUpdates: () => ipcRenderer.send('check-for-updates'),
    respondUpdate: (confirmed: boolean) => ipcRenderer.send('update-user-response', confirmed),
    respondInstall: (confirmed: boolean) => ipcRenderer.send('update-install-response', confirmed),
    respondError: () => ipcRenderer.send('update-error-response'),
    onUpdateStatus: (cb: (data: Record<string, unknown>) => void) =>
        ipcRenderer.on('update-status', (_e, data) => cb(data)),
})
