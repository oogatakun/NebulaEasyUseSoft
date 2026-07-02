import express from 'express'
import { resolve as resolvePath, join, relative, basename, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { readdir, readFile, stat, unlink, rename, mkdir } from 'fs/promises'
import { spawn } from 'child_process'
import multer from 'multer'
import dotenv from 'dotenv'
import { sseManager } from './SseLogTransport.js'
import { getGitStatus, syncToRepo, gitFetch, gitPull, gitCommitPush, getLog } from './git.js'
import {
    cmdInitRoot,
    cmdGenerateServer,
    cmdGenerateServerCurseForge,
    cmdGenerateDistro,
    cmdGenerateSchemas,
    cmdLatestForge,
    cmdRecommendedForge,
    cmdLatestFabric,
    cmdStableFabric,
    cmdFabricSupportedMcVersions,
    EnvConfig
} from './commands.js'

dotenv.config()

const __dirname = dirname(fileURLToPath(import.meta.url))
// dist/web/ → ../../src/web/public (開発時) または dist/../src/web/public
const PUBLIC_DIR = resolvePath(__dirname, '../../src/web/public')
const PROJECT_ROOT = resolvePath(__dirname, '../..')

const ASSETS_DIR = resolvePath(PROJECT_ROOT, 'assets')

const app = express()
// file:// から localhost へのリクエストを許可
app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return }
    next()
})
app.use(express.json())
app.use(express.static(PUBLIC_DIR))
app.use(express.static(ASSETS_DIR))

// ===== プロファイル管理 =====
const PROFILES_FILE = resolvePath(PROJECT_ROOT, 'profiles.json')

interface Profile {
    ROOT: string
    BASE_URL: string
    JAVA_EXECUTABLE?: string
    HELIOS_DATA_FOLDER?: string
    GIT_REPO_PATH?: string
    GIT_BRANCH?: string
    GIT_COMMIT_MSG?: string
}

interface ProfileStore {
    active: string
    profiles: Record<string, Profile>
}

function loadProfileStore(): ProfileStore {
    if (existsSync(PROFILES_FILE)) {
        try { return JSON.parse(readFileSync(PROFILES_FILE, 'utf-8')) } catch { /* fall through */ }
    }
    return { active: '', profiles: {} }
}

function saveProfileStore(store: ProfileStore): void {
    writeFileSync(PROFILES_FILE, JSON.stringify(store, null, 2), 'utf-8')
}

function applyProfile(profile: Profile): void {
    process.env.ROOT = profile.ROOT ?? ''
    process.env.BASE_URL = profile.BASE_URL ?? ''
    process.env.JAVA_EXECUTABLE = profile.JAVA_EXECUTABLE ?? ''
    process.env.HELIOS_DATA_FOLDER = profile.HELIOS_DATA_FOLDER ?? ''
    process.env.GIT_REPO_PATH = profile.GIT_REPO_PATH ?? ''
    process.env.GIT_BRANCH = profile.GIT_BRANCH ?? 'main'
    process.env.GIT_COMMIT_MSG = profile.GIT_COMMIT_MSG ?? 'Update distribution'
}

// 起動時にアクティブプロファイルを適用（プロファイルがない場合はスキップ）
const _initStore = loadProfileStore()
const _initProfile = _initStore.profiles[_initStore.active] ?? Object.values(_initStore.profiles)[0]
if (_initProfile) applyProfile(_initProfile)

function getEnvConfig(): EnvConfig {
    return {
        ROOT: process.env.ROOT ?? '',
        BASE_URL: process.env.BASE_URL ?? '',
        JAVA_EXECUTABLE: process.env.JAVA_EXECUTABLE,
        HELIOS_DATA_FOLDER: process.env.HELIOS_DATA_FOLDER
    }
}

function saveEnvConfig(config: EnvConfig): void {
    const store = loadProfileStore()
    const cur = store.profiles[store.active]
    store.profiles[store.active] = { ...cur, ...config }
    saveProfileStore(store)
    applyProfile(store.profiles[store.active])
}

function getServerDir(name: string): string {
    return join(resolvePath(getEnvConfig().ROOT), 'servers', name)
}

// カテゴリ内のファイルを再帰的に列挙
interface FileEntry {
    name: string
    relativePath: string  // カテゴリルートからの相対パス
    size: number
    dir: string           // 親ディレクトリ（ルートなら ""）
}

interface CategoryFiles {
    flat: FileEntry[]         // toggleable でない場合
    required: FileEntry[]     // toggleable の場合
    optionalon: FileEntry[]
    optionaloff: FileEntry[]
    isToggleable: boolean
}

// dirPath 以下のファイルを再帰的に収集（basePath からの相対パスを relativePath に）
function collectFiles(dirPath: string, basePath: string): FileEntry[] {
    const result: FileEntry[] = []
    if (!existsSync(dirPath)) return result
    for (const entry of readdirSync(dirPath)) {
        const fullPath = join(dirPath, entry)
        const relPath = join(dirPath, entry).slice(basePath.length + 1).replace(/\\/g, '/')
        const s = statSync(fullPath)
        if (s.isDirectory()) {
            result.push(...collectFiles(fullPath, basePath))
        } else {
            const dirPart = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
            result.push({ name: entry, relativePath: relPath, size: s.size, dir: dirPart })
        }
    }
    return result
}

function listCategory(categoryPath: string): CategoryFiles {
    const result: CategoryFiles = { flat: [], required: [], optionalon: [], optionaloff: [], isToggleable: false }
    if (!existsSync(categoryPath)) return result

    const TOGGLE_DIRS = ['required', 'optionalon', 'optionaloff']
    const entries = readdirSync(categoryPath)
    const hasToggleDirs = entries.some(e => TOGGLE_DIRS.includes(e) && statSync(join(categoryPath, e)).isDirectory())

    if (hasToggleDirs) {
        result.isToggleable = true
        for (const sub of TOGGLE_DIRS) {
            const subPath = join(categoryPath, sub)
            // toggleable の場合は sub 直下のファイルのみ（jar 単位）
            if (existsSync(subPath)) {
                for (const file of readdirSync(subPath)) {
                    const fp = join(subPath, file)
                    if (statSync(fp).isFile()) {
                        ;(result[sub as keyof typeof result] as FileEntry[]).push({
                            name: file,
                            relativePath: `${sub}/${file}`,
                            size: statSync(fp).size,
                            dir: sub
                        })
                    }
                }
            }
        }
    } else {
        // flat: サブディレクトリも再帰的に収集
        result.flat = collectFiles(categoryPath, categoryPath)
    }
    return result
}

// --- SSE ---
app.get('/api/logs', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()
    const id = Date.now().toString()
    sseManager.add(id, res)
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 30000)
    req.on('close', () => { clearInterval(heartbeat); sseManager.remove(id) })
})

// --- Version ---
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
const _pkg = _require('../../package.json')
app.get('/api/version', (_req, res) => { res.json({ version: _pkg.version }) })

// アップデート状態（HTTP 経由で main.ts から書き込む）
let _updateState: Record<string, unknown> = { status: 'checking' }
app.get('/api/update-state', (_req, res) => res.json(_updateState))
app.post('/api/update-state', express.json(), (req, res) => {
    _updateState = req.body
    res.json({ ok: true })
})
app.post('/api/update-confirm', express.json(), (req, res) => {
    _updateState = { status: 'confirming', confirmed: req.body.confirmed }
    res.json({ ok: true })
})

// --- Config ---
app.get('/api/config', (_req, res) => { res.json(getEnvConfig()) })
app.post('/api/config', (req, res) => {
    try { saveEnvConfig(req.body as EnvConfig); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Commands ---
async function runCommand(res: express.Response, fn: () => Promise<void>): Promise<void> {
    try {
        sseManager.broadcast({ type: 'start' })
        await fn()
        sseManager.broadcast({ type: 'done', success: true })
        res.json({ ok: true })
    } catch (e) {
        sseManager.broadcast({ type: 'done', success: false, error: String(e) })
        res.status(500).json({ error: String(e) })
    }
}

app.post('/api/init-root', async (req, res) => { await runCommand(res, () => cmdInitRoot(getEnvConfig())) })

app.post('/api/generate-server', async (req, res) => {
    const { id, version, forge, fabric } = req.body as Record<string, string>
    await runCommand(res, () => cmdGenerateServer(getEnvConfig(), id, version, forge || undefined, fabric || undefined))
})

app.post('/api/generate-server-curseforge', async (req, res) => {
    const { id, zipName } = req.body as Record<string, string>
    await runCommand(res, () => cmdGenerateServerCurseForge(getEnvConfig(), id, zipName))
})

app.post('/api/generate-distro', async (req, res) => {
    const { name, installLocal, discardOutput, invalidateCache } = req.body as Record<string, unknown>
    await runCommand(res, () => cmdGenerateDistro(getEnvConfig(), (name as string) || 'distribution', Boolean(installLocal), Boolean(discardOutput), Boolean(invalidateCache)))
})

app.post('/api/generate-schemas', async (req, res) => { await runCommand(res, () => cmdGenerateSchemas(getEnvConfig())) })

async function versionQuery(res: express.Response, fn: () => Promise<unknown>): Promise<void> {
    try {
        sseManager.broadcast({ type: 'start' })
        const result = await fn()
        sseManager.broadcast({ type: 'done', success: true })
        res.json({ ok: true, result })
    } catch (e) {
        sseManager.broadcast({ type: 'done', success: false })
        res.status(500).json({ error: String(e) })
    }
}

app.post('/api/latest-forge', async (req, res) => {
    const { version } = req.body as { version: string }
    await versionQuery(res, () => cmdLatestForge(version))
})
app.post('/api/recommended-forge', async (req, res) => {
    const { version } = req.body as { version: string }
    await versionQuery(res, () => cmdRecommendedForge(version))
})
app.post('/api/latest-fabric', async (_req, res) => { await versionQuery(res, cmdLatestFabric) })
app.post('/api/stable-fabric', async (_req, res) => { await versionQuery(res, cmdStableFabric) })
app.post('/api/fabric-mc-versions', async (_req, res) => { await versionQuery(res, cmdFabricSupportedMcVersions) })

// --- Servers list ---
app.get('/api/servers', async (_req, res) => {
    const env = getEnvConfig()
    if (!env.ROOT) { res.json({ servers: [] }); return }
    const serversDir = join(resolvePath(env.ROOT), 'servers')
    if (!existsSync(serversDir)) { res.json({ servers: [] }); return }
    try {
        const entries = await readdir(serversDir)
        const servers = await Promise.all(entries.map(async (name) => {
            const serverPath = join(serversDir, name)
            if (!(await stat(serverPath)).isDirectory()) return null
            const metaPath = join(serverPath, 'servermeta.json')
            let meta = null
            if (existsSync(metaPath)) {
                try { meta = JSON.parse(await readFile(metaPath, 'utf-8')) } catch { /* ignore */ }
            }
            const countJars = (dirPath: string): number => {
                try {
                    let count = 0
                    for (const item of readdirSync(dirPath)) {
                        const p = join(dirPath, item)
                        if (statSync(p).isDirectory()) count += countJars(p)
                        else if (item.endsWith('.jar')) count++
                    }
                    return count
                } catch { return 0 }
            }
            let modCount = 0
            for (const dir of ['forgemods', 'fabricmods']) modCount += countJars(join(serverPath, dir))
            return { name, meta, modCount }
        }))
        res.json({ servers: servers.filter(Boolean) })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Delete server ---
app.delete('/api/servers/:name', async (req, res) => {
    const serverDir = getServerDir(req.params['name'] as string)
    if (!existsSync(serverDir)) { res.status(404).json({ error: 'Not found' }); return }
    try {
        const { rm } = await import('fs/promises')
        await rm(serverDir, { recursive: true, force: true })
        res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Open in Explorer ---
app.post('/api/servers/:name/open-explorer', (req, res) => {
    const serverDir = getServerDir(req.params['name'] as string)
    if (!existsSync(serverDir)) { res.status(404).json({ error: 'Not found' }); return }
    spawn('explorer.exe', [serverDir], { detached: true, stdio: 'ignore' }).unref()
    res.json({ ok: true })
})

// --- Server detail ---
app.get('/api/servers/:name/detail', async (req, res) => {
    const serverDir = getServerDir(req.params.name)
    if (!existsSync(serverDir)) { res.status(404).json({ error: 'Server not found' }); return }
    try {
        const metaPath = join(serverDir, 'servermeta.json')
        const meta = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf-8')) : {}
        const files = {
            forgemods: listCategory(join(serverDir, 'forgemods')),
            fabricmods: listCategory(join(serverDir, 'fabricmods')),
            files: listCategory(join(serverDir, 'files')),
            libraries: listCategory(join(serverDir, 'libraries')),
        }
        res.json({ name: req.params.name, meta, files })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Save servermeta ---
app.post('/api/servers/:name/meta', async (req, res) => {
    const serverDir = getServerDir(req.params.name)
    try {
        const metaPath = join(serverDir, 'servermeta.json')
        const existing = existsSync(metaPath) ? JSON.parse(await readFile(metaPath, 'utf-8')) : {}
        const updated = { ...existing, meta: { ...existing.meta, ...req.body } }
        await (await import('fs/promises')).writeFile(metaPath, JSON.stringify(updated, null, 2), 'utf-8')
        res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- File upload (multer) ---
const upload = multer({ storage: multer.memoryStorage() })

app.post('/api/servers/:name/upload', upload.array('files'), async (req, res) => {
    const serverDir = getServerDir(req.params['name'] as string)
    const { category, sub } = req.body as { category: string; sub?: string }
    const files = req.files as Express.Multer.File[]
    if (!files?.length) { res.status(400).json({ error: 'No files' }); return }

    const ALLOWED_CATEGORIES = ['forgemods', 'fabricmods', 'files', 'libraries']
    if (!ALLOWED_CATEGORIES.includes(category)) { res.status(400).json({ error: 'Invalid category' }); return }

    // パストラバーサル防止（sub に ../ などが含まれていないか確認）
    const destDir = sub ? join(serverDir, category, sub) : join(serverDir, category)
    if (!destDir.startsWith(serverDir)) { res.status(400).json({ error: 'Invalid path' }); return }

    try {
        await mkdir(destDir, { recursive: true })
        const { writeFile } = await import('fs/promises')
        for (const file of files) {
            await writeFile(join(destDir, file.originalname), file.buffer)
        }
        res.json({ ok: true, count: files.length })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Delete file ---
app.delete('/api/servers/:name/file', async (req, res) => {
    const serverDir = getServerDir(req.params.name)
    const { category, relativePath } = req.body as { category: string; relativePath: string }
    // パストラバーサル防止
    const target = join(serverDir, category, relativePath)
    if (!target.startsWith(serverDir)) { res.status(400).json({ error: 'Invalid path' }); return }
    try {
        await unlink(target)
        res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- Move file ---
// toSub: toggleable の場合は "required"/"optionalon"/"optionaloff"
// toRelative: flat の場合は移動先の相対パス (例: "shaderpacks/file.zip")
app.post('/api/servers/:name/move', async (req, res) => {
    const serverDir = getServerDir(req.params.name)
    const { category, fromRelative, toSub, toRelative } = req.body as {
        category: string; fromRelative: string; toSub?: string; toRelative?: string
    }

    const fromPath = join(serverDir, category, fromRelative)
    let toPath: string

    if (toRelative !== undefined) {
        // flat カテゴリ: toRelative で直接指定
        toPath = join(serverDir, category, toRelative)
    } else {
        // toggleable カテゴリ: toSub でサブフォルダ指定
        const fileName = basename(fromRelative)
        toPath = toSub ? join(serverDir, category, toSub, fileName) : join(serverDir, category, fileName)
    }

    if (!fromPath.startsWith(serverDir) || !toPath.startsWith(serverDir)) {
        res.status(400).json({ error: 'Invalid path' }); return
    }
    try {
        await mkdir(dirname(toPath), { recursive: true })
        await rename(fromPath, toPath)
        res.json({ ok: true })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

// --- プロファイル API ---
app.get('/api/profiles', (_req, res) => {
    const store = loadProfileStore()
    res.json({ active: store.active, profiles: Object.keys(store.profiles) })
})

app.get('/api/profiles/export', (_req, res) => {
    const store = loadProfileStore()
    res.setHeader('Content-Disposition', 'attachment; filename="neus-profiles.json"')
    res.json(store)
})

app.get('/api/profiles/:name', (req, res) => {
    const store = loadProfileStore()
    const p = store.profiles[req.params.name]
    if (!p) { res.status(404).json({ error: 'Not found' }); return }
    res.json(p)
})

app.post('/api/profiles', (req, res) => {
    const { name } = req.body as { name: string }
    if (!name?.trim()) { res.status(400).json({ error: '名前を入力してください' }); return }
    const store = loadProfileStore()
    if (store.profiles[name]) { res.status(400).json({ error: '同名のプロファイルが既に存在します' }); return }
    store.profiles[name] = { ROOT: '', BASE_URL: '', GIT_BRANCH: 'main', GIT_COMMIT_MSG: 'Update distribution' }
    saveProfileStore(store)
    res.json({ ok: true })
})

app.put('/api/profiles/:name', (req, res) => {
    const store = loadProfileStore()
    if (!store.profiles[req.params.name]) { res.status(404).json({ error: 'Not found' }); return }
    store.profiles[req.params.name] = { ...store.profiles[req.params.name], ...req.body }
    saveProfileStore(store)
    if (store.active === req.params.name) applyProfile(store.profiles[req.params.name])
    res.json({ ok: true })
})

app.post('/api/profiles/:name/activate', (req, res) => {
    const store = loadProfileStore()
    if (!store.profiles[req.params.name]) { res.status(404).json({ error: 'Not found' }); return }
    store.active = req.params.name
    saveProfileStore(store)
    const p = store.profiles[req.params.name]
    applyProfile(p)
    res.json({ ok: true, profile: p })
})

app.delete('/api/profiles/:name', (req, res) => {
    const store = loadProfileStore()
    if (!store.profiles[req.params.name]) { res.status(404).json({ error: 'Not found' }); return }
    if (store.active === req.params.name) {
        const next = Object.keys(store.profiles).find(k => k !== req.params.name) ?? ''
        store.active = next
        if (next) applyProfile(store.profiles[next])
    }
    delete store.profiles[req.params.name]
    saveProfileStore(store)
    res.json({ ok: true, newActive: store.active })
})

// --- プロファイル インポート ---
app.post('/api/profiles/import', express.json(), (req, res) => {
    const incoming = req.body as ProfileStore
    if (!incoming?.profiles || typeof incoming.profiles !== 'object') {
        res.status(400).json({ error: '無効なプロファイルデータです' }); return
    }
    const store = loadProfileStore()
    // 既存プロファイルにマージ（上書き）
    for (const [name, profile] of Object.entries(incoming.profiles)) {
        store.profiles[name] = profile as Profile
    }
    if (incoming.active && store.profiles[incoming.active]) {
        store.active = incoming.active
        applyProfile(store.profiles[store.active])
    }
    saveProfileStore(store)
    res.json({ ok: true, profiles: Object.keys(store.profiles) })
})

// --- Git 設定 ---
function getGitConfig() {
    return {
        repoPath: process.env.GIT_REPO_PATH ?? '',
        branch: process.env.GIT_BRANCH ?? 'main',
        commitMsg: process.env.GIT_COMMIT_MSG ?? 'Update distribution'
    }
}

function saveGitConfig(cfg: { repoPath: string; branch: string; commitMsg: string }) {
    const store = loadProfileStore()
    store.profiles[store.active] = { ...store.profiles[store.active], GIT_REPO_PATH: cfg.repoPath, GIT_BRANCH: cfg.branch, GIT_COMMIT_MSG: cfg.commitMsg }
    saveProfileStore(store)
    applyProfile(store.profiles[store.active])
}

// フォルダ選択ダイアログ（Windows エクスプローラー形式）
app.post('/api/pick-folder', (_req, res) => {
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        '$d.Title = "Git リポジトリフォルダを選択"',
        '$d.ValidateNames = $false',
        '$d.CheckFileExists = $false',
        '$d.CheckPathExists = $true',
        '$d.FileName = "ここを空白にしてフォルダを開く"',
        'if ($d.ShowDialog() -eq "OK") { [System.IO.Path]::GetDirectoryName($d.FileName) } else { "" }'
    ].join('; ')

    const ps = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    ps.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    ps.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    ps.on('close', () => {
        const path = out.trim().split('\n').pop()?.trim() ?? ''
        res.json({ path })
    })
})

app.get('/api/git/config', (_req, res) => { res.json(getGitConfig()) })
app.post('/api/git/config', (req, res) => {
    try { saveGitConfig(req.body); res.json({ ok: true }) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

app.get('/api/git/status', async (_req, res) => {
    const { repoPath } = getGitConfig()
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定または存在しません' }); return }
    try { res.json(await getGitStatus(repoPath)) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

app.get('/api/git/log', async (_req, res) => {
    const { repoPath } = getGitConfig()
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定' }); return }
    try { res.json(await getLog(repoPath)) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

app.post('/api/git/sync', async (_req, res) => {
    const env = getEnvConfig()
    const { repoPath } = getGitConfig()
    if (!env.ROOT) { res.status(400).json({ error: 'ROOTが未設定です' }); return }
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定または存在しません' }); return }
    try {
        const copied = await syncToRepo(env.ROOT, repoPath)
        res.json({ ok: true, copied })
    } catch (e) { res.status(500).json({ error: String(e) }) }
})

app.post('/api/git/fetch', async (_req, res) => {
    const { repoPath } = getGitConfig()
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定' }); return }
    try { res.json({ ok: true, message: await gitFetch(repoPath) }) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

app.post('/api/git/pull', async (_req, res) => {
    const { repoPath } = getGitConfig()
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定' }); return }
    try { res.json({ ok: true, message: await gitPull(repoPath) }) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

app.post('/api/git/commit-push', async (req, res) => {
    const { repoPath, branch, commitMsg } = getGitConfig()
    const { message } = req.body as { message?: string }
    if (!repoPath || !existsSync(repoPath)) { res.status(400).json({ error: 'リポジトリパスが未設定' }); return }
    try { res.json({ ok: true, message: await gitCommitPush(repoPath, message || commitMsg, branch) }) }
    catch (e) { res.status(500).json({ error: String(e) }) }
})

const PORT = process.env.PORT ?? 3000
app.listen(PORT, () => {
    console.log(`\n🌟 Nebula簡単操作 が起動しました: http://localhost:${PORT}\n`)
})
