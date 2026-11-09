import got from 'got'
import type express from 'express'

export type Loader = 'none' | 'forge' | 'fabric'
const LOADERS: readonly string[] = ['none', 'forge', 'fabric']
export function isLoader(v: string): v is Loader { return LOADERS.includes(v) }

export interface Fetchers {
    text(url: string): Promise<string>
    json(url: string): Promise<unknown>
}

export interface VersionList {
    versions: string[]
    default?: string
    stale: boolean
}

export const FORGE_METADATA_URL = 'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
export const FORGE_PROMOTIONS_URL = 'https://files.minecraftforge.net/maven/net/minecraftforge/forge/promotions_slim.json'
export const MOJANG_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
export const FABRIC_GAME_URL = 'https://meta.fabricmc.net/v2/versions/game'
export const FABRIC_LOADER_URL = 'https://meta.fabricmc.net/v2/versions/loader'

const MC_RE = /^\d+\.\d+(\.\d+)?$/

export const defaultFetchers: Fetchers = {
    text: (url) => got.get(url, { timeout: { request: 15000 } }).text(),
    json: (url) => got.get(url, { timeout: { request: 15000 } }).json()
}

// "1.12.2" < "1.12.10" のように数値で比べる（正なら a が新しい）
export function compareDotted(a: string, b: string): number {
    const x = a.split('.').map(Number)
    const y = b.split('.').map(Number)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0)
        if (d !== 0) return d
    }
    return 0
}

// maven-metadata.xml → { MC バージョン → Forge ビルド一覧（新しい順） }
// ビルド名は "<MC>-<ビルド>" または古い形式の "<MC>-<ビルド>-<MC>"。MC 形式でない行は捨てる。
export function parseForgeMetadata(xml: string): Map<string, string[]> {
    const out = new Map<string, string[]>()
    for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
        const entry = m[1].trim()
        const i = entry.indexOf('-')
        if (i <= 0) continue
        const mc = entry.slice(0, i)
        if (!MC_RE.test(mc)) continue
        let rest = entry.slice(i + 1)
        if (rest.endsWith('-' + mc)) rest = rest.slice(0, -(mc.length + 1))
        if (!/^\d+(\.\d+)+$/.test(rest)) continue
        const list = out.get(mc) ?? []
        if (!list.includes(rest)) list.push(rest)
        out.set(mc, list)
    }
    for (const list of out.values()) list.sort((a, b) => compareDotted(b, a))
    return out
}

// Forge のビルドがある MC バージョンを新しい順に（1.21 以降も含む）
export function forgeSupportedMc(meta: Map<string, string[]>): string[] {
    return [...meta.keys()].sort((a, b) => compareDotted(b, a))
}

export function mojangReleases(manifest: unknown): string[] {
    const versions = (manifest as { versions?: Array<{ id: string; type: string }> } | null)?.versions ?? []
    return versions.filter(v => v.type === 'release' && MC_RE.test(v.id)).map(v => v.id)
}

export function fabricStableGames(meta: unknown): string[] {
    const list = Array.isArray(meta) ? meta as Array<{ version: string; stable: boolean }> : []
    return list.filter(v => v.stable && MC_RE.test(v.version)).map(v => v.version).sort((a, b) => compareDotted(b, a))
}

export function fabricLoaderInfo(meta: unknown): { versions: string[]; stable?: string; latest?: string } {
    const list = Array.isArray(meta) ? meta as Array<{ version: string; stable: boolean }> : []
    return { versions: list.map(v => v.version), stable: list.find(v => v.stable)?.version, latest: list[0]?.version }
}

interface CacheEntry { at: number; value: unknown }

export class VersionCatalog {
    private cache = new Map<string, CacheEntry>()

    constructor(
        private fetchers: Fetchers = defaultFetchers,
        private ttlMs = 60 * 60 * 1000,
        private now: () => number = Date.now
    ) {}

    // 1時間キャッシュ。取得に失敗したら古い値を stale で返す。古い値も無ければ例外。
    private async cached<T>(key: string, load: () => Promise<T>): Promise<{ value: T; stale: boolean }> {
        const hit = this.cache.get(key)
        if (hit && this.now() - hit.at < this.ttlMs) return { value: hit.value as T, stale: false }
        try {
            const value = await load()
            this.cache.set(key, { at: this.now(), value })
            return { value, stale: false }
        } catch (e) {
            if (hit) return { value: hit.value as T, stale: true }
            throw e
        }
    }

    private forgeMeta() {
        return this.cached('forge:meta', async () => parseForgeMetadata(await this.fetchers.text(FORGE_METADATA_URL)))
    }

    async minecraftVersions(loader: Loader): Promise<VersionList> {
        if (loader === 'forge') {
            const m = await this.forgeMeta()
            return { versions: forgeSupportedMc(m.value), stale: m.stale }
        }
        if (loader === 'fabric') {
            const g = await this.cached('fabric:game', async () => fabricStableGames(await this.fetchers.json(FABRIC_GAME_URL)))
            return { versions: g.value, stale: g.stale }
        }
        const v = await this.cached('mojang', async () => mojangReleases(await this.fetchers.json(MOJANG_MANIFEST_URL)))
        return { versions: v.value, stale: v.stale }
    }

    async loaderVersions(loader: Loader, mc: string): Promise<VersionList> {
        if (loader === 'forge') {
            const m = await this.forgeMeta()
            const list = m.value.get(mc) ?? []
            let promos: { value: unknown; stale: boolean } | null = null
            try { promos = await this.cached('forge:promos', () => this.fetchers.json(FORGE_PROMOTIONS_URL)) } catch { /* おすすめが分からないだけ。一覧は出す */ }
            const p = (promos?.value as { promos?: Record<string, string> } | undefined)?.promos ?? {}
            const pick = [p[`${mc}-recommended`], p[`${mc}-latest`]].find(v => v != null && list.includes(v))
            return { versions: list, default: pick ?? list[0], stale: m.stale || (promos?.stale ?? false) }
        }
        if (loader === 'fabric') {
            const l = await this.cached('fabric:loader', async () => fabricLoaderInfo(await this.fetchers.json(FABRIC_LOADER_URL)))
            return { versions: l.value.versions, default: l.value.stable ?? l.value.latest, stale: l.stale }
        }
        return { versions: [], stale: false }
    }
}

export function registerVersionRoutes(app: express.Express, catalog: VersionCatalog): void {
    app.get('/api/versions/minecraft', async (req, res) => {
        const loader = String(req.query.loader ?? '')
        if (!isLoader(loader)) { res.status(400).json({ ok: false, error: 'loader が不正です' }); return }
        try { res.json({ ok: true, ...(await catalog.minecraftVersions(loader)) }) }
        catch (e) { res.status(502).json({ ok: false, error: `バージョン一覧を取得できませんでした: ${String(e)}` }) }
    })
    app.get('/api/versions/loader', async (req, res) => {
        const loader = String(req.query.loader ?? '')
        const mc = String(req.query.mc ?? '')
        if (!isLoader(loader) || loader === 'none') { res.status(400).json({ ok: false, error: 'loader が不正です' }); return }
        if (!MC_RE.test(mc)) { res.status(400).json({ ok: false, error: 'mc が不正です' }); return }
        try { res.json({ ok: true, ...(await catalog.loaderVersions(loader, mc)) }) }
        catch (e) { res.status(502).json({ ok: false, error: `バージョン一覧を取得できませんでした: ${String(e)}` }) }
    })
}
