import { minimatch } from 'minimatch'
import { createHash } from 'crypto'
import { pathExists } from 'fs-extra/esm'
import { Stats } from 'fs'
import { lstat, readdir, readFile } from 'fs/promises'
import { Artifact, Module, Type, TypeMetadata } from 'helios-distribution-types'
import { resolve } from 'path'
import { BaseModelStructure } from '../BaseModel.struct.js'
import { LibraryType } from '../../../model/claritas/ClaritasLibraryType.js'
import { ClaritasResult, ClaritasModuleMetadata } from '../../../model/claritas/ClaritasResult.js'
import { ClaritasWrapper } from '../../../util/java/ClaritasWrapper.js'
import { MinecraftVersion } from '../../../util/MinecraftVersion.js'
import { UntrackedFilesOption } from '../../../model/nebula/ServerMeta.js'

export interface ModuleCandidate {
    file: string
    filePath: string
    stats: Stats
}

export interface ClaritasException {
    exceptionName: string
    proxyMetadata: ClaritasModuleMetadata
}

export abstract class ModuleStructure extends BaseModelStructure<Module> {

    private readonly crudeRegex = /(.+?)-(.+).[jJ][aA][rR]/
    protected readonly DEFAULT_VERSION = '0.0.0'
    protected readonly FILE_NAME_BLACKLIST = [
        '.gitkeep'
    ]

    protected untrackedFilePatterns: string[]          // List of glob patterns. 
    protected claritasResult!: ClaritasResult

    private readonly linkRegex = /^(.+)\.link\.json$/i

    constructor(
        absoluteRoot: string,
        relativeRoot: string,
        structRoot: string,
        baseUrl: string,
        protected minecraftVersion: MinecraftVersion,
        protected type: Type,
        untrackedFiles: UntrackedFilesOption[],
        protected filter?: ((name: string, path: string, stats: Stats) => boolean)
    ) {
        super(absoluteRoot, relativeRoot, structRoot, baseUrl)
        this.untrackedFilePatterns = this.determineUntrackedFiles(structRoot, untrackedFiles)
    }

    public async getSpecModel(): Promise<Module[]> {
        if (this.resolvedModels == null) {
            this.resolvedModels = await this._doModuleRetrieval(await this._doModuleDiscovery(this.containerDirectory))
        }

        return this.resolvedModels
    }

    protected getDefaultGroup(): string {
        return `generated.${this.type.toLowerCase()}`
    }

    protected generateMavenIdentifier(group: string, id: string, version: string): string {
        return `${group}:${id}:${version}@${TypeMetadata[this.type].defaultExtension}`
    }

    protected attemptCrudeInference(name: string): { name: string, version: string } {
        const result = this.crudeRegex.exec(name)
        if(result != null) {
            return {
                name: result[1],
                version: result[2]
            }
        } else {
            return {
                name: name.substring(0, name.lastIndexOf('.')),
                version: this.DEFAULT_VERSION
            }
        }
    }

    protected getClaritasGroup(path: string): string {
        return this.claritasResult[path]?.group || this.getDefaultGroup()
    }

    protected getClaritasExceptions(): ClaritasException[] {
        return []
    }

    protected getClaritasType(): LibraryType | null {
        return null
    }

    protected abstract getModuleId(name: string, path: string): Promise<string>
    protected abstract getModuleName(name: string, path: string): Promise<string>
    protected abstract getModuleUrl(name: string, path: string, stats: Stats): Promise<string>
    protected abstract getModulePath(name: string, path: string, stats: Stats): Promise<string | null>

    protected async parseModule(file: string, filePath: string, stats: Stats): Promise<Module> {

        // Only .link.json exists, return the module from link file.
        const linkMatch = this.linkRegex.exec(file)
        if (linkMatch != null && !await pathExists(linkMatch[1])) {
            this.logger.info(`Found only link file: ${filePath}, ${file}`)
            return JSON.parse(await readFile(filePath, { encoding: 'utf-8' })) as Module
        }

        const artifact: Artifact = {
            size: stats.size,
            url: await this.getModuleUrl(file, filePath, stats)
        }
        
        const relativeToContainer = filePath.substr(this.containerDirectory.length+1)
        const untrackedByPattern = this.isFileUntracked(relativeToContainer)
        if(!untrackedByPattern) {
            const buf = await readFile(filePath)
            artifact.MD5 = createHash('md5').update(buf).digest('hex')
        } else {
            this.logger.debug(`File ${relativeToContainer} is untracked. Matching pattern: ${untrackedByPattern}`)
        }
        
        const mdl: Module = {
            id: await this.getModuleId(file, filePath),
            name: await this.getModuleName(file, filePath),
            type: this.type,
            artifact
        }
        const pth = await this.getModulePath(file, filePath, stats)
        if (pth) {
            mdl.artifact.path = pth
        }

        // jar と .link.json が両方存在する場合は、jar を残したまま link ファイルの
        // 上書き項目（主に id）だけを適用する。これにより「配信名（id）を修正しつつ、
        // jar はリポジトリ上に残す」ことができ、リポジトリを ROOT で置き換える運用でも
        // URL が壊れない。二重取り込みは discovery 側（.link.json 候補を除外）で防ぐ。
        if (await pathExists(`${filePath}.link.json`)) {
            this.logger.info(`Found link override: ${filePath}.link.json`)
            const linkModule = JSON.parse(await readFile(`${filePath}.link.json`, { encoding: 'utf-8' })) as Partial<Module>
            if (linkModule.id) mdl.id = linkModule.id       // 配信名を決める id を上書き
            if (linkModule.name) mdl.name = linkModule.name // 表示名も指定があれば上書き
            // artifact（url/MD5/size）や required は jar 側の最新値を維持する
        }

        return mdl
    }

    protected async _doModuleDiscovery(scanDirectory: string): Promise<ModuleCandidate[]> {

        const moduleCandidates: ModuleCandidate[] = []

        if (await pathExists(scanDirectory)) {
            const files = await readdir(scanDirectory)
            for (const file of files) {
                // 対象 jar が存在する .link.json は候補から除外する。
                // （jar 側の parseModule で id 上書きを適用するため。両方を候補にすると
                //   同一 id のエントリが二重に生成されてしまう）
                const linkMatch = /^(.+)\.link\.json$/i.exec(file)
                if (linkMatch != null && files.includes(linkMatch[1])) {
                    continue
                }
                const filePath = resolve(scanDirectory, file)
                const stats = await lstat(filePath)
                if (stats.isFile()) {
                    if(!this.FILE_NAME_BLACKLIST.includes(file)) {
                        if(this.filter == null || this.filter(file, filePath, stats)) {
                            moduleCandidates.push({file, filePath, stats})
                        }
                    }
                }
            }
        }

        return moduleCandidates

    }

    protected async invokeClaritas(moduleCandidates: ModuleCandidate[]): Promise<void> {
        if(this.getClaritasType() != null) {
            const claritasExecutor = new ClaritasWrapper(this.absoluteRoot)

            let claritasCandidates = moduleCandidates
            const exceptionCandidates: [ModuleCandidate, ClaritasException][] = []
            for(const exception of this.getClaritasExceptions()) {
                const exceptionCandidate = moduleCandidates.find((value) => value.file.toLowerCase().includes(exception.exceptionName))
                if(exceptionCandidate != null) {
                    exceptionCandidates.push([exceptionCandidate, exception])
                    claritasCandidates = claritasCandidates.filter((value) => !value.file.toLowerCase().includes(exception.exceptionName))
                }
            }

            this.claritasResult = await claritasExecutor.execute(
                this.getClaritasType()!,
                this.minecraftVersion,
                claritasCandidates.map(entry => entry.filePath)
            )

            if(this.claritasResult == null) {
                this.logger.error('Failed to process Claritas result!')
                this.claritasResult = {}
            } else {
                for(const [candidate, exception] of exceptionCandidates) {
                    this.claritasResult[candidate.filePath] = exception.proxyMetadata
                }
            }
        }
    }

    protected async _doModuleRetrieval(moduleCandidates: ModuleCandidate[], options?: {
        preProcess?: (candidate: ModuleCandidate) => void
        postProcess?: (module: Module) => void
    }): Promise<Module[]> {

        const accumulator: Module[] = []
        
        if(moduleCandidates.length > 0) {

            // Invoke Claritas and attach result to class.
            await this.invokeClaritas(moduleCandidates)
    
            // Process Modules
            for(const candidate of moduleCandidates) {
                options?.preProcess?.(candidate)
                const mdl = await this.parseModule(candidate.file, candidate.filePath, candidate.stats)
                options?.postProcess?.(mdl)
                accumulator.push(mdl)
            }

        }
        
        return accumulator

    }

    protected determineUntrackedFiles(targetStructRoot: string, untrackedFileOptions?: UntrackedFilesOption[]): string[] {
        if(untrackedFileOptions) {
            return untrackedFileOptions
                .filter(x => x.appliesTo.includes(targetStructRoot))
                .reduce((acc, cur) => acc.concat(cur.patterns), [] as string[])
        }
        return []
    }

    // Will return the matching pattern, undefined if no match.
    protected isFileUntracked(pathRelativeToContainer: string): string | undefined {
        return this.untrackedFilePatterns.find(pattern => minimatch(pathRelativeToContainer, pattern))
    }

}
