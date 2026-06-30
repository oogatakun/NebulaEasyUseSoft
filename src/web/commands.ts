import { writeFile } from 'fs/promises'
import { resolve as resolvePath } from 'path'
import { URL } from 'url'
import { inspect } from 'util'
import { DistributionStructure } from '../structure/spec_model/Distribution.struct.js'
import { ServerStructure } from '../structure/spec_model/Server.struct.js'
import { VersionUtil } from '../util/VersionUtil.js'
import { MinecraftVersion } from '../util/MinecraftVersion.js'
import { LoggerUtil } from '../util/LoggerUtil.js'
import { generateSchemas } from '../util/SchemaUtil.js'
import { CurseForgeParser } from '../parser/CurseForgeParser.js'
import { SseLogTransport } from './SseLogTransport.js'
import { Logger, transports } from 'winston'

export interface EnvConfig {
    ROOT: string
    BASE_URL: string
    JAVA_EXECUTABLE?: string
    HELIOS_DATA_FOLDER?: string
}

function buildLogger(label: string, useSse: boolean): Logger {
    const logger = LoggerUtil.getLogger(label)
    if (useSse) {
        logger.add(new SseLogTransport())
    }
    return logger
}

function resolveBaseURL(baseUrl: string): string {
    if (!baseUrl.includes('//')) {
        if (baseUrl.toLowerCase().startsWith('localhost')) {
            baseUrl = 'http://' + baseUrl
        } else {
            throw new TypeError('URLプロトコルを指定してください (例: http:// または https://)')
        }
    }
    return new URL(baseUrl).toString()
}

export async function cmdInitRoot(env: EnvConfig): Promise<void> {
    const logger = buildLogger('InitRoot', true)
    const root = resolvePath(env.ROOT)
    logger.debug(`Root set to ${root}`)
    logger.debug('Invoked init root.')
    try {
        await generateSchemas(root)
        await new DistributionStructure(root, '', false, false).init()
        await new CurseForgeParser(root, '').init()
        logger.info(`Successfully created new root at ${root}`)
    } catch (error) {
        logger.error(`Failed to init new root at ${root}`, error)
        throw error
    }
}

export async function cmdGenerateServer(env: EnvConfig, id: string, version: string, forge?: string, fabric?: string): Promise<void> {
    const logger = buildLogger('GenServer', true)
    const root = resolvePath(env.ROOT)
    const baseUrl = resolveBaseURL(env.BASE_URL)
    const minecraftVersion = new MinecraftVersion(version)

    logger.debug(`Root set to ${root}`)

    if (forge != null) {
        if (VersionUtil.isPromotionVersion(forge)) {
            logger.debug(`Resolving ${forge} Forge version...`)
            forge = await VersionUtil.getPromotedForgeVersion(minecraftVersion, forge)
            logger.debug(`Forge version resolved to ${forge}`)
        }
        if (minecraftVersion.isGreaterThanOrEqualTo(new MinecraftVersion('1.20.3'))) {
            logger.error('Forge 1.20.3+ では --fml.modLists が削除されました。Fabric または NeoForged を使用してください。')
        }
    }

    if (fabric != null && VersionUtil.isPromotionVersion(fabric)) {
        logger.debug(`Resolving ${fabric} Fabric version...`)
        fabric = await VersionUtil.getPromotedFabricVersion(fabric)
        logger.debug(`Fabric version resolved to ${fabric}`)
    }

    const serverStruct = new ServerStructure(root, baseUrl, false, false)
    await serverStruct.createServer(id, minecraftVersion, { forgeVersion: forge, fabricVersion: fabric })
    logger.info(`Successfully generated server: ${id} (${version})`)
}

export async function cmdGenerateServerCurseForge(env: EnvConfig, id: string, zipName: string): Promise<void> {
    const logger = buildLogger('GenCurseForge', true)
    const root = resolvePath(env.ROOT)
    const baseUrl = resolveBaseURL(env.BASE_URL)

    logger.debug(`Root set to ${root}`)
    logger.debug(`Generating server ${id} from CurseForge modpack ${zipName}`)

    const parser = new CurseForgeParser(root, zipName)
    const modpackManifest = await parser.getModpackManifest()
    const minecraftVersion = new MinecraftVersion(modpackManifest.minecraft.version)

    const forgeModLoader = modpackManifest.minecraft.modLoaders.find(({ id }) => id.toLowerCase().startsWith('forge-'))
    const forgeVersion = forgeModLoader != null ? forgeModLoader.id.substring('forge-'.length) : undefined

    logger.debug(`Forge version: ${forgeVersion}`)

    const serverStruct = new ServerStructure(root, baseUrl, false, false)
    const result = await serverStruct.createServer(id, minecraftVersion, { version: modpackManifest.version, forgeVersion })

    if (result) {
        await parser.enrichServer(result, modpackManifest)
    }
    logger.info(`Successfully generated server: ${id}`)
}

export async function cmdGenerateDistro(
    env: EnvConfig,
    name = 'distribution',
    installLocal = false,
    discardOutput = false,
    invalidateCache = false
): Promise<void> {
    const logger = buildLogger('GenDistro', true)
    const root = resolvePath(env.ROOT)
    const baseUrl = resolveBaseURL(env.BASE_URL)
    const finalName = `${name}.json`

    logger.debug(`Root: ${root}`)
    logger.debug(`Base URL: ${baseUrl}`)
    logger.debug(`installLocal=${installLocal}, discardOutput=${discardOutput}, invalidateCache=${invalidateCache}`)

    const heliosDataFolder = env.HELIOS_DATA_FOLDER ? resolvePath(env.HELIOS_DATA_FOLDER) : null
    if (installLocal && heliosDataFolder == null) {
        throw new Error('installLocal を使用するには HELIOS_DATA_FOLDER を設定してください。')
    }

    const distributionStruct = new DistributionStructure(root, baseUrl, discardOutput, invalidateCache)
    const distro = await distributionStruct.getSpecModel()
    const distroOut = JSON.stringify(distro, null, 2)
    const distroPath = resolvePath(root, finalName)
    await writeFile(distroPath, distroOut)
    logger.info(`Successfully generated ${finalName}`)
    logger.info(`Saved to ${distroPath}`)

    if (installLocal && heliosDataFolder) {
        const dest = resolvePath(heliosDataFolder, finalName)
        await writeFile(dest, distroOut)
        logger.info(`Installed to ${dest}`)
    }
}

export async function cmdGenerateSchemas(env: EnvConfig): Promise<void> {
    const logger = buildLogger('GenSchemas', true)
    const root = resolvePath(env.ROOT)
    logger.debug(`Root set to ${root}`)
    await generateSchemas(root)
    logger.info('Successfully generated schemas')
}

export async function cmdLatestForge(version: string): Promise<string> {
    const logger = buildLogger('LatestForge', true)
    const minecraftVersion = new MinecraftVersion(version)
    const forgeVer = await VersionUtil.getPromotedForgeVersion(minecraftVersion, 'latest')
    logger.info(`Latest Forge for ${version}: ${forgeVer}`)
    return forgeVer
}

export async function cmdRecommendedForge(version: string): Promise<string | null> {
    const logger = buildLogger('RecommendedForge', true)
    const index = await VersionUtil.getPromotionIndex()
    const minecraftVersion = new MinecraftVersion(version)
    let forgeVer = VersionUtil.getPromotedVersionStrict(index, minecraftVersion, 'recommended')
    if (forgeVer != null) {
        logger.info(`Recommended Forge for ${version}: ${forgeVer}`)
    } else {
        logger.info(`推奨バージョンなし。最新バージョンを確認中...`)
        forgeVer = VersionUtil.getPromotedVersionStrict(index, minecraftVersion, 'latest')
        if (forgeVer != null) {
            logger.info(`Latest Forge for ${version}: ${forgeVer}`)
        } else {
            logger.info(`${version} に対応するForgeビルドはありません。`)
        }
    }
    return forgeVer
}

export async function cmdLatestFabric(): Promise<string> {
    const logger = buildLogger('FabricVersion', true)
    logger.debug('Fetching latest Fabric loader version...')
    const version = await VersionUtil.getPromotedFabricVersion('latest')
    logger.info(`Latest Fabric Loader: ${version}`)
    return version
}

export async function cmdStableFabric(): Promise<string> {
    const logger = buildLogger('FabricVersion', true)
    logger.debug('Fetching stable Fabric loader version...')
    const version = await VersionUtil.getPromotedFabricVersion('recommended')
    logger.info(`Stable Fabric Loader: ${version}`)
    return version
}

export async function cmdFabricSupportedMcVersions(): Promise<string[]> {
    const logger = buildLogger('FabricVersion', true)
    logger.debug('Fetching Fabric supported Minecraft versions...')
    const meta = await VersionUtil.getFabricGameMeta()
    const stable = meta.filter(v => v.stable).map(v => v.version)
    logger.info(`Stable MC versions supported by Fabric: ${stable.slice(0, 5).join(', ')}... (${stable.length} total)`)
    return stable
}
