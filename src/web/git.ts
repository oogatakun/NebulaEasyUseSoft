import { simpleGit, SimpleGit, StatusResult, CheckRepoActions } from 'simple-git'
import { existsSync, cpSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs'
import { resolve as resolvePath, join } from 'path'
import { spawn } from 'child_process'

// 子プロセスを実行し、stdout/stderr と終了コードを収集する（起動失敗も spawnError として返す）
function runProcess(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; spawnError?: Error }> {
    return new Promise((resolve) => {
        let child
        try {
            child = spawn(cmd, args, { windowsHide: true })
        } catch (e) {
            resolve({ code: null, stdout: '', stderr: '', spawnError: e as Error }); return
        }
        let stdout = '', stderr = '', done = false
        const finish = (r: { code: number | null; stdout: string; stderr: string; spawnError?: Error }) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(r) } }
        const timer = opts.timeoutMs ? setTimeout(() => { try { child!.kill() } catch { /* ignore */ } finish({ code: null, stdout, stderr, spawnError: new Error('timeout') }) }, opts.timeoutMs) : undefined
        child.stdout.on('data', d => { stdout += d.toString() })
        child.stderr.on('data', d => { stderr += d.toString() })
        child.on('error', (e) => finish({ code: null, stdout, stderr, spawnError: e }))
        child.on('close', (code) => finish({ code, stdout, stderr }))
        if (opts.input !== undefined) { child.stdin.write(opts.input); child.stdin.end() }
    })
}

export interface GitLinkStatus {
    gitInstalled: boolean
    gitVersion: string | null
    authenticated: boolean
    username: string | null
    tokenValid: boolean | null   // true=有効, false=無効/期限切れ, null=検証不可(オフライン等)
}

// Git for Windows（git コマンド）が使えるか
export async function checkGitVersion(): Promise<{ installed: boolean; version: string | null }> {
    const r = await runProcess('git', ['--version'], { timeoutMs: 10000 })
    if (r.spawnError || r.code !== 0) return { installed: false, version: null }
    const m = r.stdout.match(/git version ([^\s]+)/i)
    return { installed: true, version: m ? m[1] : r.stdout.trim() }
}

// GitHub 認証情報を取得（未保存なら Git Credential Manager が認証UIを起動して取得・保存する）
async function fetchGithubCredential(): Promise<{ hasCredential: boolean; username: string | null; password: string | null }> {
    const input = 'protocol=https\nhost=github.com\n\n'
    const r = await runProcess('git', ['credential', 'fill'], { input, timeoutMs: 300000 })
    if (r.spawnError || r.code !== 0) return { hasCredential: false, username: null, password: null }
    const username = r.stdout.match(/^username=(.*)$/m)?.[1]?.trim() ?? null
    const password = r.stdout.match(/^password=(.*)$/m)?.[1]?.trim() ?? null
    return { hasCredential: !!password, username, password }
}

// GitHub のアクセストークン（git credential 経由）を取得する。
// Release API など GitHub REST API 呼び出しで再利用する。
export async function getGithubToken(): Promise<string | null> {
    const cred = await fetchGithubCredential()
    return cred.hasCredential ? cred.password : null
}

// 取得したトークンが実際に有効か GitHub API で検証し、ログイン名を得る
async function validateGithubToken(password: string | null): Promise<{ valid: boolean | null; login: string | null }> {
    if (!password) return { valid: false, login: null }
    const call = (scheme: string) => fetch('https://api.github.com/user', {
        headers: { Authorization: `${scheme} ${password}`, 'User-Agent': 'ModNebula', Accept: 'application/vnd.github+json' }
    })
    try {
        let res = await call('Bearer')
        if (res.status === 401 || res.status === 403) res = await call('token')
        if (res.status === 200) {
            const data = await res.json() as { login?: string }
            return { valid: true, login: data.login ?? null }
        }
        if (res.status === 401 || res.status === 403) return { valid: false, login: null }
        return { valid: null, login: null }
    } catch {
        return { valid: null, login: null } // ネットワーク到達不可などは「検証不可」
    }
}

// Git for Windows のインストール確認 ＋ GitHub 認証（＝連携状態の総合チェック）。トークンはクライアントへ返さない。
export async function checkGitLink(): Promise<GitLinkStatus> {
    const ver = await checkGitVersion()
    if (!ver.installed) {
        return { gitInstalled: false, gitVersion: null, authenticated: false, username: null, tokenValid: null }
    }
    const cred = await fetchGithubCredential()
    if (!cred.hasCredential) {
        return { gitInstalled: true, gitVersion: ver.version, authenticated: false, username: null, tokenValid: null }
    }
    const v = await validateGithubToken(cred.password)
    return {
        gitInstalled: true,
        gitVersion: ver.version,
        authenticated: v.valid !== false,          // 無効と断定された場合のみ未認証扱い
        username: v.login ?? cred.username,
        tokenValid: v.valid
    }
}

// ROOT から git リポジトリへコピーするターゲット
export const SYNC_TARGETS = ['modpacks', 'repo', 'servers', 'meta']
const SYNC_FILES = ['distribution.json']

// ロックに強い削除（Windows で ENOTEMPTY/EBUSY が出た時にリトライする）
function safeRemove(target: string): void {
    rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

// dest 内で src に存在しないファイル/フォルダだけを削除する（フォルダ丸ごと削除は避ける）
function removeExtras(srcDir: string, destDir: string): void {
    if (!existsSync(destDir)) return
    for (const entry of readdirSync(destDir)) {
        const s = join(srcDir, entry)
        const d = join(destDir, entry)
        if (!existsSync(s)) {
            safeRemove(d)                       // src に無い → 余分なので削除
        } else if (statSync(d).isDirectory() && statSync(s).isDirectory()) {
            removeExtras(s, d)                  // 両方フォルダ → 再帰的に差分削除
        }
    }
}

// src の内容で dest を「置き換え（ミラー）」する。
// フォルダを丸ごと削除せず、コピー＋余分ファイルの削除で行うため、
// ロック中ファイルや大量ファイルでも失敗しにくく、git にも優しい。
function mirrorDir(src: string, dest: string): void {
    cpSync(src, dest, { recursive: true, force: true })  // 追加・更新
    removeExtras(src, dest)                               // 余分を削除
}

export interface GitStatus {
    branch: string
    tracking: string | null
    ahead: number
    behind: number
    staged: string[]
    modified: string[]
    untracked: string[]
    isRepo: boolean
}

export async function getGitStatus(repoPath: string): Promise<GitStatus> {
    const git = simpleGit(repoPath)
    const status: StatusResult = await git.status()
    return {
        branch: status.current ?? 'unknown',
        tracking: status.tracking,
        ahead: status.ahead,
        behind: status.behind,
        staged: status.staged,
        modified: [...status.modified, ...status.deleted],
        untracked: status.not_added,
        isRepo: true
    }
}

// ROOT → リポジトリへ「置き換え（ミラー）」コピー。
// 各対象フォルダはコピー前にリポジトリ側を削除してから複製するため、
// ROOT で移動・削除したファイルはリポジトリ側からも消え、ROOT と完全一致する。
export async function syncToRepo(rootPath: string, repoPath: string): Promise<string[]> {
    const copied: string[] = []

    for (const dir of SYNC_TARGETS) {
        const src = join(resolvePath(rootPath), dir)
        const dest = join(resolvePath(repoPath), dir)
        if (existsSync(src)) {
            mirrorDir(src, dest)               // 置き換え（コピー＋余分削除、丸ごと削除しない）
            copied.push(dir)
        } else if (existsSync(dest)) {
            safeRemove(dest)                   // ROOT 側に対象が無い場合はリポジトリ側からも除去
            copied.push(`${dir} (削除)`)
        }
    }

    for (const file of SYNC_FILES) {
        const src = join(resolvePath(rootPath), file)
        const dest = join(resolvePath(repoPath), file)
        if (existsSync(src)) {
            cpSync(src, dest, { force: true })
            copied.push(file)
        } else if (existsSync(dest)) {
            safeRemove(dest)
            copied.push(`${file} (削除)`)
        }
    }

    return copied
}

// リポジトリ → ROOT へ「置き換え（ミラー）」コピー（syncToRepo の逆方向）。
// 各対象フォルダはコピー前に ROOT 側を削除してから複製するため、
// リポジトリで移動・削除したファイルが ROOT 側にも正しく反映される（servers 等を丸ごと置き換え）。
export async function syncFromRepo(rootPath: string, repoPath: string): Promise<string[]> {
    const copied: string[] = []

    for (const dir of SYNC_TARGETS) {
        const src = join(resolvePath(repoPath), dir)
        const dest = join(resolvePath(rootPath), dir)
        if (existsSync(src)) {
            mirrorDir(src, dest)               // 置き換え（コピー＋余分削除、丸ごと削除しない）
            copied.push(dir)
        }
        // リポジトリ側に対象が無い場合は ROOT 側を消さない（ローカル専用フォルダの誤削除防止）
    }

    for (const file of SYNC_FILES) {
        const src = join(resolvePath(repoPath), file)
        const dest = join(resolvePath(rootPath), file)
        if (existsSync(src)) {
            cpSync(src, dest, { force: true })
            copied.push(file)
        }
    }

    return copied
}

export async function gitFetch(repoPath: string): Promise<string> {
    const git = simpleGit(repoPath)
    await git.fetch()
    const status = await git.status()
    return `フェッチ完了。リモートより ${status.behind} コミット遅れています。`
}

export async function gitPull(repoPath: string): Promise<string> {
    const git = simpleGit(repoPath)
    const result = await git.pull()
    const summary = result.summary
    return `プル完了。${summary.changes} 件変更、${summary.insertions} 行追加、${summary.deletions} 行削除。`
}

export async function gitCommitPush(repoPath: string, message: string, branch: string): Promise<string> {
    const git = simpleGit(repoPath)
    await git.add('.')
    const commit = await git.commit(message)
    if (commit.summary.changes === 0 && !commit.commit) {
        // 新しい変更は無い。ただし前回 push に失敗したコミットが残っていれば送信する。
        const status = await git.status()
        if (status.ahead === 0) {
            return '変更なし。コミットするものがありません。'
        }
        await git.push('origin', branch)
        return `未送信のコミット ${status.ahead} 件を送信しました。`
    }
    await git.push('origin', branch)
    return `コミット＆プッシュ完了。(${commit.commit})`
}

// distribution.json をリポジトリから削除してコミット＆プッシュする
// （再生成しても内容が同一だと git が差分なしと判断して反映されない問題への対処用）
export async function removeDistributionAndCommit(repoPath: string, branch: string, fileName = 'distribution.json'): Promise<string> {
    const git = simpleGit(repoPath)
    const abs = join(resolvePath(repoPath), fileName)
    if (!existsSync(abs)) {
        return `${fileName} はリポジトリに存在しません（削除は不要です）。`
    }
    // git 管理下なら git rm、未追跡ならファイル削除のみ
    let tracked = true
    try {
        await git.rm(fileName)
    } catch {
        tracked = false
        try { unlinkSync(abs) } catch { /* ignore */ }
    }
    if (!tracked) {
        return `${fileName} を削除しました（未追跡のためコミットは不要です）。`
    }
    const commit = await git.commit(`Remove ${fileName}`)
    await git.push('origin', branch)
    return `${fileName} を削除してコミット＆プッシュしました。(${commit.commit})`
}

// 公開用フォルダが使える Git リポジトリか（リポジトリ直下であること・origin があること）を調べる
export async function getRepoFacts(repoPath: string): Promise<{ isRepo: boolean; hasOrigin: boolean }> {
    try {
        const git = simpleGit(repoPath)
        const isRepo = await git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT)
        if (!isRepo) return { isRepo: false, hasOrigin: false }
        const remotes = await git.getRemotes(false)
        return { isRepo: true, hasOrigin: remotes.some(r => r.name === 'origin') }
    } catch {
        return { isRepo: false, hasOrigin: false }
    }
}

// fetch して、GitHub より何コミット遅れているかを返す。失敗（通信不可・タイムアウト等）は error で返す。
export async function fetchBehind(repoPath: string, timeoutMs = 20000): Promise<{ behind: number } | { error: string }> {
    try {
        const git = simpleGit({ baseDir: repoPath, timeout: { block: timeoutMs } })
        await git.fetch()
        const status = await git.status()
        return { behind: status.behind }
    } catch (e) {
        return { error: String(e) }
    }
}

// ROOT の distribution.json を公開用フォルダへコピーする（復旧用）。コピーしたら true
export function copyDistributionToRepo(rootPath: string, repoPath: string, fileName = 'distribution.json'): boolean {
    const src = join(resolvePath(rootPath), fileName)
    if (!existsSync(src)) return false
    cpSync(src, join(resolvePath(repoPath), fileName), { force: true })
    return true
}

// fetch して、未送信のコミット数（ahead）と GitHub の新しい更新数（behind）を返す。失敗は error で返す。
export async function fetchAheadBehind(repoPath: string, timeoutMs = 20000): Promise<{ ahead: number; behind: number } | { error: string }> {
    try {
        const git = simpleGit({ baseDir: repoPath, timeout: { block: timeoutMs } })
        await git.fetch()
        const status = await git.status()
        return { ahead: status.ahead, behind: status.behind }
    } catch (e) {
        return { error: String(e) }
    }
}

// 送信できていない手元のコミットを捨てて、GitHub（origin/<branch>）の内容に置き換える。
// 手元の未コミット変更も消えるので、呼ぶ前に isRepoDirty で確認すること。
export async function discardLocalCommits(repoPath: string, branch: string, timeoutMs = 20000): Promise<void> {
    const git = simpleGit({ baseDir: repoPath, timeout: { block: timeoutMs } })
    await git.fetch()
    await git.raw(['reset', '--hard', `origin/${branch}`])
}

// 公開用フォルダに未コミットの変更（ステージ済み・変更・削除・名前変更・競合・未追跡）があるか
export async function isRepoDirty(repoPath: string): Promise<boolean> {
    const status = await simpleGit(repoPath).status()
    return !status.isClean()
}

export async function getLog(repoPath: string, count = 10): Promise<Array<{ hash: string; date: string; message: string; author: string }>> {
    const git = simpleGit(repoPath)
    const log = await git.log({ maxCount: count })
    return log.all.map(l => ({
        hash: l.hash.slice(0, 7),
        date: l.date,
        message: l.message,
        author: l.author_name
    }))
}
