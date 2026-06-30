import { app, BrowserWindow, shell, nativeImage, dialog, ipcMain } from 'electron'
import { fileURLToPath } from 'url'
import { dirname, join, resolve as resolvePath } from 'path'
import { existsSync } from 'fs'
import pkg from 'electron-updater'
const { autoUpdater } = pkg

const __dirname = dirname(fileURLToPath(import.meta.url))
const ICON_PATH = resolvePath(__dirname, '../../assets/icon.ico')

app.setAppUserModelId('com.nebulasoftware.modnebula')

import '../web/server.js'

let win: BrowserWindow | null = null

async function waitForServer(url: string, maxMs = 10000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < maxMs) {
        try { await fetch(url); return } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 150))
    }
}

function setupAutoUpdater(onDone: () => void) {
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    // どのルートでも一度だけ onDone を呼ぶ
    let done = false
    const finish = () => { if (!done) { done = true; onDone() } }

    // フォールバック：30秒後に強制遷移
    setTimeout(finish, 30000)

    autoUpdater.on('checking-for-update', () => {
        win?.webContents.send('update-status', { status: 'checking' })
    })

    autoUpdater.on('update-available', (info) => {
        win?.webContents.send('update-status', { status: 'available', version: info.version })
    })

    autoUpdater.on('update-not-available', () => {
        win?.webContents.send('update-status', { status: 'not-available' })
        setTimeout(finish, 800)
    })

    autoUpdater.on('download-progress', (progress) => {
        win?.webContents.send('update-status', {
            status: 'downloading',
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total
        })
    })

    autoUpdater.on('update-downloaded', (info) => {
        win?.webContents.send('update-status', { status: 'downloaded', version: info.version })
        dialog.showMessageBox({
            type: 'info',
            title: 'アップデート準備完了',
            message: `バージョン ${info.version} のダウンロードが完了しました。`,
            detail: 'アプリを再起動してアップデートを適用しますか？',
            buttons: ['今すぐ再起動', 'あとで'],
            defaultId: 0
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall()
            else finish()
        })
    })

    autoUpdater.on('error', (err) => {
        win?.webContents.send('update-status', { status: 'error', message: err.message })
        setTimeout(finish, 2000)
    })

    autoUpdater.checkForUpdates()
}

// レンダラーから手動チェック要求（メインアプリ画面から）
ipcMain.on('check-for-updates', () => { autoUpdater.checkForUpdates() })
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
        autoHideMenuBar: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: join(__dirname, 'preload.js')
        }
    })

    win.loadFile(join(__dirname, '../../src/web/public/loading.html'))

    waitForServer('http://localhost:3000').then(() => {
        win?.webContents.send('update-status', { status: 'server-ready' })

        if (!app.isPackaged) {
            // 開発モードではアップデートチェックをスキップ
            setTimeout(() => win?.loadURL('http://localhost:3000'), 500)
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
