import { readFileSync } from 'fs'
import { getGithubToken } from './git.js'

const API = 'https://api.github.com'

// "owner/repo" / "https://github.com/owner/repo(.git)" を正規化する
export function parseRepo(repo: string): { owner: string; repo: string } {
    const s = repo.trim()
    const m = s.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i)
    if (m) return { owner: m[1], repo: m[2] }
    const parts = s.replace(/\.git$/i, '').split('/').filter(Boolean)
    if (parts.length >= 2) return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] }
    throw new Error(`アセットリポジトリの指定が不正です: ${repo}`)
}

async function authHeaders(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    const token = await getGithubToken()
    if (!token) throw new Error('GitHub のトークンを取得できません。GitHub連携（認証）を先に行ってください。')
    return {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ModNebula',
        'X-GitHub-Api-Version': '2022-11-28',
        ...extra
    }
}

// GitHub のアセット名サニタイズ（空白・記号→ドット）に合わせる
function sanitizeAssetName(name: string): string {
    return name.replace(/[^A-Za-z0-9._-]/g, '.')
}

interface GhAsset { id: number; name: string; browser_download_url: string }

// 空リポジトリを README 作成で初期化する（Release は最低1コミット必要なため）
async function createInitialCommit(owner: string, repo: string): Promise<void> {
    const content = Buffer.from('# more-mods\n\nModNebula large-file assets (hosted as GitHub Releases).\n').toString('base64')
    const res = await fetch(`${API}/repos/${owner}/${repo}/contents/README.md`, {
        method: 'PUT',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: 'Initialize repository for ModNebula assets', content })
    })
    if (res.status !== 201 && res.status !== 200) {
        throw new Error(`リポジトリ初期化に失敗しました (HTTP ${res.status}): ${await res.text()}`)
    }
}

async function tryCreateRelease(owner: string, repo: string, tag: string): Promise<{ status: number; text: string }> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ tag_name: tag, name: tag, body: 'ModNebula large-file assets' })
    })
    return { status: res.status, text: await res.text() }
}

// タグの Release を取得。無ければ作成する（空リポは初期化してから）。
export async function ensureRelease(repoSpec: string, tag: string): Promise<{ id: number; uploadUrl: string }> {
    const { owner, repo } = parseRepo(repoSpec)

    const getRes = await fetch(`${API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: await authHeaders() })
    if (getRes.status === 200) {
        const r = await getRes.json() as { id: number; upload_url: string }
        return { id: r.id, uploadUrl: r.upload_url.replace(/\{.*\}$/, '') }
    }
    if (getRes.status !== 404) {
        throw new Error(`Release 取得に失敗しました (HTTP ${getRes.status}): ${await getRes.text()}`)
    }

    let created = await tryCreateRelease(owner, repo, tag)
    if (created.status === 422 && /empty/i.test(created.text)) {
        await createInitialCommit(owner, repo)
        created = await tryCreateRelease(owner, repo, tag)
    }
    if (created.status !== 201) {
        throw new Error(`Release 作成に失敗しました (HTTP ${created.status}): ${created.text}`)
    }
    const r = JSON.parse(created.text) as { id: number; upload_url: string }
    return { id: r.id, uploadUrl: r.upload_url.replace(/\{.*\}$/, '') }
}

async function listAssets(owner: string, repo: string, releaseId: number): Promise<GhAsset[]> {
    const res = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`, { headers: await authHeaders() })
    if (res.status !== 200) throw new Error(`アセット一覧取得に失敗 (HTTP ${res.status})`)
    return await res.json() as GhAsset[]
}

// 既存の同名アセットの browser_download_url を返す（無ければ null）
export async function findAssetUrl(repoSpec: string, releaseId: number, assetName: string): Promise<string | null> {
    const { owner, repo } = parseRepo(repoSpec)
    const sanitized = sanitizeAssetName(assetName)
    const assets = await listAssets(owner, repo, releaseId)
    const hit = assets.find(a => a.name === sanitized || a.name === assetName)
    return hit ? hit.browser_download_url : null
}

// ファイルをアップロード（同名があれば削除してから）。browser_download_url を返す。
export async function uploadReleaseAsset(repoSpec: string, releaseId: number, filePath: string, assetName: string): Promise<string> {
    const { owner, repo } = parseRepo(repoSpec)
    const sanitized = sanitizeAssetName(assetName)

    // Release を取得して upload_url と既存アセットを得る
    const relRes = await fetch(`${API}/repos/${owner}/${repo}/releases/${releaseId}`, { headers: await authHeaders() })
    if (relRes.status !== 200) throw new Error(`Release 取得に失敗しました (HTTP ${relRes.status})`)
    const rel = await relRes.json() as { upload_url: string; assets: GhAsset[] }

    // 既存同名を削除
    for (const a of (rel.assets || [])) {
        if (a.name === sanitized) {
            await fetch(`${API}/repos/${owner}/${repo}/releases/assets/${a.id}`, { method: 'DELETE', headers: await authHeaders() })
        }
    }

    const uploadUrl = rel.upload_url.replace(/\{.*\}$/, '')
    const body = readFileSync(filePath)
    const res = await fetch(`${uploadUrl}?name=${encodeURIComponent(sanitized)}`, {
        method: 'POST',
        headers: await authHeaders({ 'Content-Type': 'application/java-archive' }),
        body
    })
    if (res.status !== 201) {
        throw new Error(`アセットのアップロードに失敗しました (HTTP ${res.status}): ${await res.text()}`)
    }
    const asset = await res.json() as GhAsset
    return asset.browser_download_url
}
