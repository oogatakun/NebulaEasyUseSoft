import { simpleGit, SimpleGit, StatusResult } from 'simple-git'
import { existsSync, cpSync } from 'fs'
import { resolve as resolvePath, join } from 'path'

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
