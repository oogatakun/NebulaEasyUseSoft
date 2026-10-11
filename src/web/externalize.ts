import { readFileSync, writeFileSync, statSync, unlinkSync, existsSync, readdirSync } from 'fs'
import { createHash } from 'crypto'
import { join, basename, resolve as resolvePath } from 'path'
import StreamZip from 'node-stream-zip'
import { ensureRelease, uploadReleaseAsset, deleteReleaseAssetByUrl } from './githubRelease.js'

export interface ExternalizeResult { module: Record<string, unknown>; linkFile: string; url: string }

function crudeInfer(fileName: string): { name: string; version: string } {
    const m = /(.+?)-(.+)\.[jJ][aA][rR]$/.exec(fileName)
    if (m) return { name: m[1], version: m[2] }
    return { name: fileName.replace(/\.[^.]+$/, ''), version: '0.0.0' }
}

function readModsTomlDisplayName(jarPath: string): Promise<string | null> {
    return new Promise((resolve) => {
        let zip: StreamZip
        try { zip = new StreamZip({ file: jarPath, storeEntries: true }) } catch { resolve(null); return }
        zip.on('error', () => { try { zip.close() } catch { /* */ } resolve(null) })
        zip.on('ready', () => {
            try {
                const buf = zip.entryDataSync('META-INF/mods.toml')
                try { zip.close() } catch { /* */ }
                const m = buf.toString().match(/displayName\s*=\s*"([^"]*)"/)
                resolve(m ? m[1] : null)
            } catch { try { zip.close() } catch { /* */ } resolve(null) }
        })
    })
}

// serverDir 内の category/relativePath にある jar を外部化する。
// Release にアップロード → <jar>.link.json 作成 → 元 jar を ROOT から除去。
export async function externalizeFile(
    serverDir: string, serverName: string, category: string, relativePath: string,
    assetRepo: string, releaseTag: string
): Promise<ExternalizeResult> {
    const rel = relativePath.replace(/\\/g, '/')
    if (!/\.jar$/i.test(rel) || /\.link\.json$/i.test(rel)) throw new Error('jarファイルを指定してください')
    const jarPath = join(serverDir, category, rel)
    if (!jarPath.startsWith(serverDir)) throw new Error('Invalid path')
    if (!existsSync(jarPath)) throw new Error('ファイルが見つかりません')
    if (!assetRepo) throw new Error('アセットリポジトリ(ASSET_REPO)が未設定です。GitHub連携ページで設定してください。')

    const fileName = basename(rel)
    const buf = readFileSync(jarPath)
    const md5 = createHash('md5').update(buf).digest('hex')
    const size = statSync(jarPath).size

    // Release にアップロード
    const relInfo = await ensureRelease(assetRepo, releaseTag)
    const url = await uploadReleaseAsset(assetRepo, relInfo.id, jarPath, fileName)

    // カテゴリに応じたモジュールを構築
    const parts = rel.split('/')
    const namespace = parts.length > 1 ? parts[0] : ''
    let module: Record<string, unknown>
    if (category === 'forgemods' || category === 'fabricmods') {
        const type = category === 'forgemods' ? 'ForgeMod' : 'FabricMod'
        const group = `generated.${type.toLowerCase()}`
        const crude = crudeInfer(fileName)
        const displayName = (await readModsTomlDisplayName(jarPath)) || fileName.replace(/\.jar$/i, '')
        module = { id: `${group}:${crude.name}:${crude.version}@jar`, name: displayName, type, artifact: { size, url, MD5: md5 } }
        if (namespace === 'optionalon') module.required = { value: false }
        else if (namespace === 'optionaloff') module.required = { value: false, def: false }
    } else {
        // files カテゴリ: Type.File, id=ファイル名, path=相対パス
        module = { id: fileName, name: fileName, type: 'File', artifact: { size, url, MD5: md5, path: rel } }
    }

    // link.json 書き出し → jar 除去
    const linkPath = `${jarPath}.link.json`
    writeFileSync(linkPath, JSON.stringify(module, null, 2), 'utf-8')
    unlinkSync(jarPath)

    return { module, linkFile: basename(linkPath), url }
}

// 外部化の解除: Release から jar をダウンロードして復元し、.link.json を削除する。
export async function unexternalizeFile(serverDir: string, category: string, relativePath: string): Promise<{ restored: string; assetDeleted: boolean; assetError?: string }> {
    const rel = relativePath.replace(/\\/g, '/')
    const jarPath = join(serverDir, category, rel)
    const linkPath = `${jarPath}.link.json`
    if (!jarPath.startsWith(serverDir)) throw new Error('Invalid path')
    if (!existsSync(linkPath)) throw new Error('link.json が見つかりません')
    const mod = JSON.parse(readFileSync(linkPath, 'utf-8')) as { artifact?: { url?: string } }
    const url = mod.artifact?.url
    if (!url) throw new Error('link.json に url がありません')
    const res = await fetch(url)
    if (!res.ok) throw new Error(`ダウンロードに失敗しました (HTTP ${res.status}): ${url}`)
    const dl = Buffer.from(await res.arrayBuffer())
    writeFileSync(jarPath, dl)

    // jar 復元に成功したので、Release 側のアセットも削除する（GitHub Release URL の場合）
    let assetDeleted = false
    let assetError: string | undefined
    try { assetDeleted = await deleteReleaseAssetByUrl(url) }
    catch (e) { assetError = String(e) }

    unlinkSync(linkPath)
    return { restored: basename(jarPath), assetDeleted, assetError }
}

const MOD_CATEGORIES = ['forgemods', 'fabricmods', 'files']

// rootPath/servers/<srv>/<category>/** を走査し、閾値超の .jar（.link.json が無いもの）を外部化
export async function scanAndExternalize(
    rootPath: string, assetRepo: string, releaseTag: string, threshold: number
): Promise<string[]> {
    const done: string[] = []
    const serversDir = join(resolvePath(rootPath), 'servers')
    if (!existsSync(serversDir)) return done
    for (const srv of readdirSync(serversDir)) {
        const serverDir = join(serversDir, srv)
        if (!statSync(serverDir).isDirectory()) continue
        for (const cat of MOD_CATEGORIES) {
            const catDir = join(serverDir, cat)
            if (!existsSync(catDir)) continue
            const pending: string[] = []
            const walk = (dir: string): void => {
                for (const entry of readdirSync(dir)) {
                    const p = join(dir, entry)
                    const st = statSync(p)
                    if (st.isDirectory()) { walk(p); continue }
                    if (!/\.jar$/i.test(entry)) continue
                    if (existsSync(`${p}.link.json`)) continue    // 既に外部化/リンク済み
                    if (st.size <= threshold) continue             // 閾値以下
                    pending.push(p.slice(catDir.length + 1).replace(/\\/g, '/'))
                }
            }
            walk(catDir)
            for (const relPath of pending) {
                await externalizeFile(serverDir, srv, cat, relPath, assetRepo, releaseTag)
                done.push(`${srv}/${cat}/${relPath}`)
            }
        }
    }
    return done
}
