import { app, BrowserWindow, shell, nativeImage, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join, resolve as resolvePath } from 'path'
import { existsSync } from 'fs'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICON_PATH = resolvePath(__dirname, '../../assets/icon.ico')

app.setAppUserModelId('com.nebulasoftware.modnebula')

let win: BrowserWindow | null = null

// loading.html の UI を直接更新する
function pushState(state: Record<string, unknown>) {
    win?.webContents.executeJavaScript(
        `window.__onUpdateState && window.__onUpdateState(${JSON.stringify(state)})`
    ).catch(() => {})
}

async function waitForServer(url: string, maxMs = 15000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
        try { await fetch(url); return } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 150))
    }
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

    // サーバー起動中はローカルファイルのスピナーを表示
    win.loadFile(join(__dirname, '../../src/web/public/startup.html'))

    // サーバー起動後に loading.html を http:// で読み込む
    waitForServer('http://localhost:3000').then(async () => {
        await new Promise<void>(resolve => {
            win!.webContents.once('did-finish-load', resolve)
            win!.loadURL('http://localhost:3000/loading.html')
        })
        if (!app.isPackaged) {
            setTimeout(() => win?.loadURL('http://localhost:3000'), 800)
        } else {
            setupAutoUpdater(() => win?.loadURL('http://localhost:3000'))
        }
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url)
        return { action: 'deny' }
    })

    win.on('closed', () => { win = null })
}

app.whenReady().then(createWindow)
app.on('window-all-closed', () => { app.quit() })
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
