import { existsSync, readdirSync, statSync, readFileSync } from 'fs'
import { join, resolve as resolvePath } from 'path'
import {
    SYNC_TARGETS, syncToRepo, syncFromRepo, gitCommitPush, gitPull, removeDistributionAndCommit,
    getRepoFacts, fetchBehind, copyDistributionToRepo, isRepoDirty, checkGitVersion,
    fetchAheadBehind, discardLocalCommits
} from './git.js'
import { listOversized } from './externalize.js'

// ===== 型 =====

export type StageId = 'generate' | 'reflect' | 'send' | 'reinstall' | 'verify'
export type StageStatus = 'running' | 'done' | 'error' | 'warn'
// percent: ここまでの目安の進み具合（0〜100）。next: 今の処理が終わったときの percent（画面が間をなめらかに進めるのに使う）
export interface PublishEvent { stage: StageId; status: StageStatus; message?: string; percent?: number; next?: number }

export interface PublishContext {
    root: string            // ROOT の絶対パス（未設定なら空文字）
    repoPath: string        // 公開用フォルダ（Git リポジトリ）
    branch: string
    commitMsg: string
    baseUrl: string
    asset: { repo: string; tag: string; threshold: number }
}

export interface PublishDeps {
    generate(): Promise<void>                                                  // 閾値超ファイルの外部化＋ distribution.json の生成
    fetchText(url: string): Promise<{ status: number; text: string }>
    sleep?(ms: number): Promise<void>                                          // テストで差し替える
}

export type VerifyState = 'match' | 'pending' | 'unreachable'
export interface VerifyResult { state: VerifyState; detail: string }

export type PublishResult =
    | { ok: true; verify: VerifyResult }
    | { ok: false; stage: StageId; error: string; recovered?: boolean; recoveryFailed?: boolean }

// ===== 排他制御（公開と取り込みで共有） =====

export class BusyError extends Error {
    constructor() {
        super('別の公開処理が実行中です。終わってからやり直してください。')
        this.name = 'BusyError'
    }
}

let busy = false
export function isBusy(): boolean { return busy }

export async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    if (busy) throw new BusyError()
    busy = true
    try { return await fn() } finally { busy = false }
}

// ===== 公開URLと結果の確認 =====

// BASE_URL（フォルダ形式でもファイル形式でも可）を検証して正規化する。不正なら Error
export function normalizeBaseUrl(baseUrl: string): string {
    let b = (baseUrl ?? '').trim()
    if (!b) throw new Error('BASE_URL が未設定です。')
    if (!b.includes('//')) {
        if (b.toLowerCase().startsWith('localhost')) b = 'http://' + b
        else throw new Error('BASE_URL にプロトコル（http:// または https://）を指定してください。')
    }
    return new URL(b).toString()
}

export function publicDistributionUrl(baseUrl: string): string {
    return new URL('distribution.json', normalizeBaseUrl(baseUrl)).toString()
}

const normalizeJson = (text: string): string | null => {
    try { return JSON.stringify(JSON.parse(text)) } catch { return null }
}

// 公開URLから distribution.json を取得し、手元のものと内容が一致するか確認する。
// キャッシュ回避のためクエリ（?t=現在時刻）を付ける。違う場合は intervalMs 間隔で attempts 回まで再試行する。
export async function verifyPublic(
    publicUrl: string,
    localPath: string,
    deps: Pick<PublishDeps, 'fetchText' | 'sleep'>,
    attempts = 3,
    intervalMs = 4000
): Promise<VerifyResult> {
    let local: string | null = null
    try { local = normalizeJson(readFileSync(localPath, 'utf-8')) } catch { /* local は null のまま */ }
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)))
    let last: VerifyResult = { state: 'unreachable', detail: '公開URLを取得できませんでした。' }
    for (let i = 0; i < attempts; i++) {
        if (i > 0) await sleep(intervalMs)
        const sep = publicUrl.includes('?') ? '&' : '?'
        try {
            const res = await deps.fetchText(`${publicUrl}${sep}t=${Date.now()}`)
            if (res.status !== 200) {
                last = { state: 'unreachable', detail: `公開URLにアクセスできません（HTTP ${res.status}）。リポジトリの公開設定と URL を確認してください。` }
                continue
            }
            if (local !== null && normalizeJson(res.text) === local) {
                return { state: 'match', detail: 'GitHub の公開版と一致しました。' }
            }
            last = { state: 'pending', detail: 'GitHub の反映待ちです。最大5分ほどでランチャーに届きます。' }
        } catch (e) {
            last = { state: 'unreachable', detail: `公開URLを取得できませんでした（${String(e)}）。` }
        }
    }
    return last
}

// ===== 準備チェック =====

export interface PreflightCheck {
    id: 'root' | 'baseUrl' | 'git' | 'repo' | 'upstream' | 'asset'
    label: string
    status: 'ok' | 'warn' | 'error'
    detail: string
    fix?: 'config' | 'github' | 'pull'
}
export interface PreflightResult { canPublish: boolean; checks: PreflightCheck[] }

const okCheck = (id: PreflightCheck['id'], label: string, detail: string): PreflightCheck => ({ id, label, status: 'ok', detail })
const warnCheck = (id: PreflightCheck['id'], label: string, detail: string): PreflightCheck => ({ id, label, status: 'warn', detail })
const errCheck = (id: PreflightCheck['id'], label: string, detail: string, fix?: PreflightCheck['fix']): PreflightCheck =>
    ({ id, label, status: 'error', detail, fix })

// 公開できる状態かを調べる。通信するのは git fetch だけ。
// GitHub の認証は確認しない（資格情報の確認でサインイン画面が出ることがあるため）。
export async function preflight(ctx: PublishContext): Promise<PreflightResult> {
    const checks: PreflightCheck[] = []

    // 作業フォルダ
    if (!ctx.root) checks.push(errCheck('root', '作業フォルダ', '作業フォルダ（ROOT）が未設定です。', 'config'))
    else if (!existsSync(ctx.root)) checks.push(errCheck('root', '作業フォルダ', `作業フォルダが見つかりません: ${ctx.root}`, 'config'))
    else checks.push(okCheck('root', '作業フォルダ', ctx.root))

    // 公開先URL
    try { checks.push(okCheck('baseUrl', '公開先URL', publicDistributionUrl(ctx.baseUrl))) }
    catch (e) { checks.push(errCheck('baseUrl', '公開先URL', (e as Error).message, 'config')) }

    // Git
    const ver = await checkGitVersion()
    checks.push(ver.installed
        ? okCheck('git', 'Git', `Git ${ver.version}`)
        : errCheck('git', 'Git', 'Git for Windows がインストールされていません。', 'github'))

    // 公開用フォルダ
    let repoOk = false
    if (!ctx.repoPath) {
        checks.push(errCheck('repo', '公開用フォルダ', '公開用フォルダが未設定です。', 'github'))
    } else if (!existsSync(ctx.repoPath)) {
        checks.push(errCheck('repo', '公開用フォルダ', `公開用フォルダが見つかりません: ${ctx.repoPath}`, 'github'))
    } else {
        const facts = await getRepoFacts(ctx.repoPath)
        if (!facts.isRepo) checks.push(errCheck('repo', '公開用フォルダ', '公開用フォルダが Git リポジトリではありません。パスを確認してください。', 'github'))
        else if (!facts.hasOrigin) checks.push(errCheck('repo', '公開用フォルダ', 'GitHub への接続先（origin）が設定されていません。', 'github'))
        else { checks.push(okCheck('repo', '公開用フォルダ', ctx.repoPath)); repoOk = true }
    }

    // 他の人の更新（fetch の失敗は警告にとどめ、公開は止めない）
    if (repoOk && ver.installed) {
        const r = await fetchBehind(ctx.repoPath)
        if ('error' in r) checks.push(warnCheck('upstream', '他の人の更新', 'GitHub の更新を確認できませんでした（通信できない可能性があります）。'))
        else if (r.behind > 0) checks.push(errCheck('upstream', '他の人の更新', `他の人の更新が ${r.behind} 件あります。先に「最新を取り込む」を押してください。`, 'pull'))
        else checks.push(okCheck('upstream', '他の人の更新', '他の人の更新はありません。'))
    }

    // 大容量ファイル
    if (ctx.root && existsSync(ctx.root)) {
        const big = listOversized(ctx.root, ctx.asset.threshold)
        if (big.length === 0) checks.push(okCheck('asset', '大容量ファイル', '大容量ファイルはありません。'))
        else if (!ctx.asset.repo) checks.push(errCheck('asset', '大容量ファイル', `大容量ファイルが ${big.length} 件あります。GitHub 連携ページでアセット用リポジトリを設定してください。`, 'github'))
        else checks.push(okCheck('asset', '大容量ファイル', `大容量ファイル ${big.length} 件は公開時に外部リリース化します。`))
    }

    return { canPublish: checks.every(c => c.status !== 'error'), checks }
}

// ===== 公開の実行 =====

// ④で distribution.json を GitHub から消した後に失敗した場合の復旧。
// ROOT の distribution.json（無ければ再生成したもの）を公開用フォルダへ戻して送信する。成功したら true。
async function recoverDistribution(ctx: PublishContext, deps: PublishDeps): Promise<boolean> {
    try {
        if (!existsSync(join(ctx.root, 'distribution.json'))) await deps.generate()
        copyDistributionToRepo(ctx.root, ctx.repoPath)
        await gitCommitPush(ctx.repoPath, ctx.commitMsg, ctx.branch)
        return true
    } catch {
        return false
    }
}

// 公開する。段階ごとの進行を emit で通知し、結果を返す（例外は投げない）。
// 処理の中身は従来のワンクリック配信（8手順）と同じ。画面上は5段階にまとめている。
export async function runPublish(
    ctx: PublishContext,
    deps: PublishDeps,
    emit: (e: PublishEvent) => void
): Promise<PublishResult> {
    let stage: StageId = 'generate'
    let removalAttempted = false
    try {
        // ① 配信データを作る
        // percent / next は進み具合の目安（配信データ作りと GitHub への送信が重いので、その分を大きく取っている）
        stage = 'generate'
        emit({ stage, status: 'running', message: '配信データを作っています…', percent: 0, next: 25 })
        await deps.generate()
        emit({ stage, status: 'done', percent: 25, next: 25 })

        // ② 公開用フォルダへ反映
        stage = 'reflect'
        emit({ stage, status: 'running', message: '公開用フォルダへ反映しています…', percent: 25, next: 33 })
        await syncToRepo(ctx.root, ctx.repoPath)
        emit({ stage, status: 'done', percent: 33, next: 33 })

        // ③ GitHub に送る
        stage = 'send'
        emit({ stage, status: 'running', message: 'GitHub に送っています…', percent: 33, next: 45 })
        const sent = await gitCommitPush(ctx.repoPath, ctx.commitMsg, ctx.branch)
        emit({ stage, status: 'done', message: sent, percent: 45, next: 45 })

        // ④ 入れ直し（distribution.json を一度外して戻す。ランチャーへ確実に伝えるための従来の手順）
        stage = 'reinstall'
        emit({ stage, status: 'running', message: '公開ファイルを一度外しています…', percent: 45, next: 53 })
        removalAttempted = true
        await removeDistributionAndCommit(ctx.repoPath, ctx.branch)
        emit({ stage, status: 'running', message: '最新の状態を取り込んでいます…', percent: 53, next: 57 })
        await syncFromRepo(ctx.root, ctx.repoPath)
        emit({ stage, status: 'running', message: '配信データを作り直しています…', percent: 57, next: 80 })
        await deps.generate()
        emit({ stage, status: 'running', message: '公開用フォルダへ反映しています…', percent: 80, next: 85 })
        await syncToRepo(ctx.root, ctx.repoPath)
        emit({ stage, status: 'running', message: 'GitHub に送っています…', percent: 85, next: 93 })
        await gitCommitPush(ctx.repoPath, ctx.commitMsg, ctx.branch)
        emit({ stage, status: 'done', percent: 93, next: 93 })
    } catch (e) {
        const error = String(e)
        emit({ stage, status: 'error', message: error })
        if (stage === 'reinstall' && removalAttempted) {
            const recovered = await recoverDistribution(ctx, deps)
            return { ok: false, stage, error, recovered, recoveryFailed: !recovered }
        }
        return { ok: false, stage, error }
    }

    // ⑤ 公開結果を確認（push は成功しているので、ここでの警告は公開全体の失敗にしない）
    emit({ stage: 'verify', status: 'running', message: '公開結果を確認しています…', percent: 93, next: 100 })
    let verify: VerifyResult
    try {
        verify = await verifyPublic(publicDistributionUrl(ctx.baseUrl), join(ctx.root, 'distribution.json'), deps)
    } catch (e) {
        verify = { state: 'unreachable', detail: `公開結果を確認できませんでした（${String(e)}）。` }
    }
    emit({ stage: 'verify', status: verify.state === 'match' ? 'done' : 'warn', message: verify.detail, percent: 100, next: 100 })
    return { ok: true, verify }
}

// ===== 最新の取り込み =====

function collectSizes(base: string, dir: string, out: Map<string, number>): void {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        const st = statSync(p)
        if (st.isDirectory()) collectSizes(base, p, out)
        else out.set(p.slice(base.length + 1).replace(/\\/g, '/'), st.size)
    }
}

// ROOT と公開用フォルダの違い（片方にだけある・サイズが違うファイル）を相対パスで返す。
// 「最新を取り込む」で手元の未公開の変更を上書きしてしまわないかの確認に使う。
export function diffRootRepo(root: string, repoPath: string): string[] {
    const a = resolvePath(root)
    const b = resolvePath(repoPath)
    const changes: string[] = []
    for (const target of SYNC_TARGETS) {
        const left = new Map<string, number>()
        const right = new Map<string, number>()
        collectSizes(a, join(a, target), left)
        collectSizes(b, join(b, target), right)
        for (const [rel, size] of left) if (right.get(rel) !== size) changes.push(rel)
        for (const rel of right.keys()) if (!left.has(rel)) changes.push(rel)
    }
    return [...new Set(changes)].sort()
}

export type PullResult =
    | { ok: true; message: string; pending?: boolean }
    | { ok: false; needsConfirm: true; changes: string[]; diverged?: { ahead: number; behind: number } }
    | { ok: false; needsConfirm?: false; error: string }

// 最新を取り込む（GitHub → 公開用フォルダ → ROOT）。
// 手元に未公開の変更があるときは force でない限り止めて確認を求める。
// 実際に取り込みを始める直前に onStart を呼ぶ。onProgress は進み具合の目安（percent と、その処理が終わったときの next）を通知する。
export async function runPull(
    ctx: Pick<PublishContext, 'root' | 'repoPath' | 'branch'>,
    force = false,
    onStart?: () => void,
    onProgress?: (percent: number, next: number, label: string) => void
): Promise<PullResult> {
    try {
        if (!ctx.root || !existsSync(ctx.root)) return { ok: false, error: '作業フォルダ（ROOT）が見つかりません。' }
        if (!ctx.repoPath || !existsSync(ctx.repoPath)) return { ok: false, error: '公開用フォルダが見つかりません。' }
        if (await isRepoDirty(ctx.repoPath)) {
            return { ok: false, error: '公開用フォルダに未送信の変更があります。先に「公開する」で送信してください。' }
        }
        const ab = await fetchAheadBehind(ctx.repoPath)
        if ('error' in ab) return { ok: false, error: ab.error }
        if (ab.ahead > 0 && ab.behind > 0) {
            // 送信できていない公開があり、GitHub にも新しい更新がある（枝分かれ）。
            // 確認のうえ、手元の未送信コミットを捨てて GitHub の内容に置き換える。
            if (!force) return { ok: false, needsConfirm: true, changes: diffRootRepo(ctx.root, ctx.repoPath), diverged: { ahead: ab.ahead, behind: ab.behind } }
            onStart?.()
            onProgress?.(5, 50, 'GitHub の内容に置き換えています…')
            await discardLocalCommits(ctx.repoPath, ctx.branch)
            onProgress?.(50, 95, '作業フォルダへ反映しています…')
            await syncFromRepo(ctx.root, ctx.repoPath)
            return { ok: true, message: `送信できていない公開（${ab.ahead} 件）を捨てて、GitHub の最新（${ab.behind} 件）に置き換えました。` }
        }
        if (ab.ahead > 0) {
            // 取り込むものは無く、未送信の公開があるだけ。何も書き換えない。
            return { ok: true, pending: true, message: '取り込む更新はありません。未送信の公開があるので、「公開する」で送信してください。' }
        }
        if (!force) {
            const changes = diffRootRepo(ctx.root, ctx.repoPath)
            if (changes.length > 0) return { ok: false, needsConfirm: true, changes }
        }
        onStart?.()
        onProgress?.(5, 50, 'GitHub から最新を取り込んでいます…')
        const message = await gitPull(ctx.repoPath)
        onProgress?.(50, 95, '作業フォルダへ反映しています…')
        await syncFromRepo(ctx.root, ctx.repoPath)
        return { ok: true, message }
    } catch (e) {
        return { ok: false, error: String(e) }
    }
}
