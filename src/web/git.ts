import { simpleGit, SimpleGit, StatusResult } from 'simple-git'
import { existsSync, cpSync, unlinkSync } from 'fs'
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
const SYNC_TARGETS = ['modpacks', 'repo', 'servers', 'meta']
const SYNC_FILES = ['distribution.json']

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

export async function syncToRepo(rootPath: string, repoPath: string): Promise<string[]> {
    const copied: string[] = []

    for (const dir of SYNC_TARGETS) {
        const src = join(resolvePath(rootPath), dir)
        const dest = join(resolvePath(repoPath), dir)
        if (existsSync(src)) {
            cpSync(src, dest, { recursive: true, force: true })
            copied.push(dir)
        }
    }

    for (const file of SYNC_FILES) {
        const src = join(resolvePath(rootPath), file)
        const dest = join(resolvePath(repoPath), file)
        if (existsSync(src)) {
            cpSync(src, dest)
            copied.push(file)
        }
    }

    return copied
}

// リポジトリ → ROOT へコピー（syncToRepo の逆方向。プル後に作業フォルダへ反映する用途）
export async function syncFromRepo(rootPath: string, repoPath: string): Promise<string[]> {
    const copied: string[] = []

    for (const dir of SYNC_TARGETS) {
        const src = join(resolvePath(repoPath), dir)
        const dest = join(resolvePath(rootPath), dir)
        if (existsSync(src)) {
            cpSync(src, dest, { recursive: true, force: true })
            copied.push(dir)
        }
    }

    for (const file of SYNC_FILES) {
        const src = join(resolvePath(repoPath), file)
        const dest = join(resolvePath(rootPath), file)
        if (existsSync(src)) {
            cpSync(src, dest)
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
        return '変更なし。コミットするものがありません。'
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
