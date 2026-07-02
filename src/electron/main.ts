import { app, BrowserWindow, shell, nativeImage, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join, resolve as resolvePath } from 'path'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

// Electron環境での動的インポートを処理
let serverApp: any = null
let serverServer: any = null

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICON_PATH = resolvePath(__dirname, '../../assets/icon.ico')

async function loadServer() {
    if (app.isPackaged) {
        // パッケージ版：Express を直接インポート
        const { app: expressApp } = await import('../web/server.js')
        serverApp = expressApp
        return expressApp
    } else {
        // 開発版：相対パスからインポート
        const { app: expressApp } = await import('../web/server.js')
        serverApp = expressApp
        return expressApp
    }
}

function startServer() {
    if (!serverApp) {
        console.error('[Server] Express app not loaded')
        win?.webContents.executeJavaScript(`document.getElementById('status').textContent = 'サーバーの読み込みに失敗しました'`).catch(() => {})
        return
    }

    const PORT = process.env.PORT ?? 3000
    console.log(`[Server] Starting Express server on port ${PORT}`)

    serverServer = serverApp.listen(PORT, () => {
        console.log(`[Server] Server started on http://localhost:${PORT}`)
    })

    serverServer.on('error', (err: any) => {
        console.error('[Server] Server error:', err.message)
        win?.webContents.executeJavaScript(`document.getElementById('status').textContent = 'サーバーエラー: ' + ${JSON.stringify(err.message)}`).catch(() => {})
    })
}

app.setAppUserModelId('com.nebulasoftware.modnebula')

let win: BrowserWindow | null = null

// loading.html と main app の両方に状態を通知
function pushState(state: Record<string, unknown>) {
    // loading.html へ：executeJavaScript
    win?.webContents.executeJavaScript(
        `window.__onUpdateState && window.__onUpdateState(${JSON.stringify(state)})`
    ).catch(() => {})
    // main app へ：IPC (主に手動チェック時)
    win?.webContents.send('update-status', state)
}

async function waitForServer(url: string, maxMs = 15000): Promise<void> {
    const start = Date.now()
    let lastError: string | null = null
    while (Date.now() - start < maxMs) {
        try {
            await fetch(url)
            return
        } catch (e) {
            lastError = String(e)
        }
        await new Promise(r => setTimeout(r, 150))
    }
    const elapsed = Date.now() - start
    const errMsg = `Server timeout after ${elapsed}ms: ${lastError}`
    console.error(`[Server] ${errMsg}`)
    win?.webContents.executeJavaScript(`document.getElementById('status').textContent = ${JSON.stringify(errMsg)}`).catch(() => {})
}

function setupAutoUpdater(onDone: () => void) {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false

    let done = false
    const finish = () => { if (!done) { done = true; onDone() } }

    // フォールバック：30秒後に強制遷移
    setTimeout(finish, 30000)

    // ユーザーが loading.html のボタンを押したら IPC で受け取る
    ipcMain.once('update-user-response', (_e, confirmed: boolean) => {
        if (confirmed) {
            autoUpdater.downloadUpdate().catch((err) => {
                pushState({ status: 'error', message: err?.message ?? String(err) })
            })
        } else {
            finish()
        }
    })

    ipcMain.once('update-install-response', (_e, confirmed: boolean) => {
        if (confirmed) autoUpdater.quitAndInstall()
        else finish()
    })

    ipcMain.once('update-error-response', () => finish())

    autoUpdater.on('checking-for-update', () => {
        pushState({ status: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
        pushState({ status: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
        pushState({ status: 'not-available' })
        setTimeout(finish, 1200)
    })

    autoUpdater.on('download-progress', (progress) => {
        pushState({ status: 'downloading', percent: Math.round(progress.percent) })
    })

    autoUpdater.on('update-downloaded', (info) => {
        pushState({ status: 'downloaded', version: info.version })
    })

    autoUpdater.on('error', (err) => {
        pushState({ status: 'error', message: err?.message ?? String(err) })
    })

    autoUpdater.checkForUpdates().catch((err) => {
        pushState({ status: 'error', message: err?.message ?? String(err) })
    })
}

ipcMain.handle('get-version', () => app.getVersion())

function createWindow() {
    const icon = existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : undefined

    win = new BrowserWindow({
        width: 1400,
        height: 860,
        minWidth: 900,
        minHeight: 600,
        title: 'Nebula簡単操作',
        icon,
        backgroundColor: '#1a1a2e',
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(__dirname, 'preload.cjs')
        }
    })

    // サーバー起動中はインライン HTML でスピナーを表示
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:'Segoe UI',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:20px}
h1{font-size:2rem;color:#7ec8e3;letter-spacing:2px}
.spinner{width:40px;height:40px;border:3px solid rgba(126,200,227,0.2);border-top-color:#7ec8e3;border-radius:50%;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
p{font-size:0.9rem;color:#888}
#status{min-height:1.2em;color:#f44336}
</style></head><body>
<h1>🌟 Nebula簡単操作</h1>
<div class="spinner"></div>
<p id="status">サーバーを起動中...</p>
</body></html>`))

    // サーバー起動後に loading.html を http:// で読み込む
    win.webContents.once('did-finish-load', () => {
        waitForServer('http://localhost:3000').then(async () => {
            await new Promise<void>(resolve => {
                const onLoad = () => {
                    win!.webContents.off('did-finish-load', onLoad)
                    resolve()
                }
                win!.webContents.on('did-finish-load', onLoad)
                win!.loadURL('http://localhost:3000/loading.html')
            })
            if (!app.isPackaged) {
                setTimeout(() => win?.loadURL('http://localhost:3000'), 800)
            } else {
                setupAutoUpdater(() => win?.loadURL('http://localhost:3000'))
            }
        })
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: 'deny' }
    })

    win.on('closed', () => { win = null })
}

app.whenReady().then(async () => {
    await loadServer()
    startServer()
    createWindow()
})

app.on('window-all-closed', () => {
    if (serverServer) {
        serverServer.close()
        serverServer = null
    }
    app.quit()
})
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
