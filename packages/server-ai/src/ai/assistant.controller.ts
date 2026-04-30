import { Assistant } from '@langchain/langgraph-sdk'
import {
    getAgentMiddlewareNodes,
    ICopilotModel,
    IWFNMiddleware,
    isRequiredMiddleware,
    IXpert,
    ModelPropertyKey,
    normalizeMiddlewareProvider
} from '@xpert-ai/contracts'
import { ApiKeyOrClientSecretAuthGuard, Public, TransformInterceptor } from '@xpert-ai/server-core'
import { Body, Controller, Get, Logger, Param, Post, UseGuards, UseInterceptors } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { AgentMiddlewareRegistry, normalizeContextSize, RequestContext } from '@xpert-ai/plugin-sdk'
import { isNil, omitBy, pick } from 'lodash-es'
import { AssistantBindingService } from '../assistant-binding'
import { PublishedXpertAccessService } from '../xpert'
import { SkillPackageService } from '../skill-package'
import { SKILLS_MIDDLEWARE_NAME } from '../skill-package/types'

const ASSISTANT_RELATIONS = ['agent', 'agent.copilotModel', 'copilotModel']

@ApiTags('AI/Assistants')
@ApiBearerAuth()
@Public()
@UseGuards(ApiKeyOrClientSecretAuthGuard)
@UseInterceptors(TransformInterceptor)
@Controller('assistants')
export class AssistantsController {
    readonly #logger = new Logger(AssistantsController.name)

    constructor(
        private readonly publishedXpertAccessService: PublishedXpertAccessService,
        private readonly assistantBindingService: AssistantBindingService,
        private readonly agentMiddlewareRegistry: AgentMiddlewareRegistry,
        private readonly skillPackageService: SkillPackageService
    ) {}

    @Post('search')
    async search(@Body() query: { limit: number; offset: number; graph_id?: string; metadata?: any }) {
        this.#logger.log(`Search Assistants: ${JSON.stringify(query)}`)
        const assistants = await this.publishedXpertAccessService.findAccessiblePublishedXperts({
            where: transformMetadata2Where(query.metadata),
            relations: ASSISTANT_RELATIONS,
            take: query.limit,
            skip: query.offset
        })
        return assistants.map(transformAssistant)
    }

    @Post('count')
    async count(@Body() body: { graph_id?: string; metadata?: any }) {
        this.#logger.log(`Count Assistants: ${JSON.stringify(body)}`)
        const where = transformMetadata2Where(body?.metadata)
        if (body?.graph_id) {
            where['id'] = body.graph_id
        }
        return this.publishedXpertAccessService.countAccessiblePublishedXperts(where)
    }

    @Get(':id')
    async getOne(@Param('id') id: string) {
        const item = (await this.assistantBindingService.isEffectiveSystemAssistantId(id))
            ? await this.publishedXpertAccessService.getPublishedXpertInTenant(id, {
                  relations: ASSISTANT_RELATIONS
              })
            : await this.publishedXpertAccessService.getAccessiblePublishedXpert(id, {
                  relations: ASSISTANT_RELATIONS
              })
        return transformAssistant(item)
    }

    @Get(':id/runtime-capabilities')
    async getRuntimeCapabilities(@Param('id') id: string) {
        const xpert = (await this.assistantBindingService.isEffectiveSystemAssistantId(id))
            ? await this.publishedXpertAccessService.getPublishedXpertInTenant(id, {
                  relations: ASSISTANT_RELATIONS
              })
            : await this.publishedXpertAccessService.getAccessiblePublishedXpert(id, {
                  relations: ASSISTANT_RELATIONS
              })
        const agentKey = getAssistantPrimaryAgentKey(xpert)
        const graph = xpert.graph
        const middlewareNodes = agentKey && graph ? getAgentMiddlewareNodes(graph, agentKey) : []
        const hasSkillsMiddleware = middlewareNodes.some((node) => {
            const entity = node.entity as unknown as IWFNMiddleware
            return normalizeMiddlewareProvider(entity?.provider) === SKILLS_MIDDLEWARE_NAME
        })
        const defaultSkillSelection = collectDefaultSkillSelection(middlewareNodes)

        const plugins = middlewareNodes
            .map((node) => {
                const entity = node.entity as unknown as IWFNMiddleware
                const provider = normalizeMiddlewareProvider(entity?.provider)
                if (!provider || provider === SKILLS_MIDDLEWARE_NAME || isRequiredMiddleware(entity)) {
                    return null
                }

                const strategy = tryGetMiddlewareStrategy(this.agentMiddlewareRegistry, provider)
                const meta = strategy?.meta
                const runtimeMeta = omitBy(
                    {
                        icon: meta?.icon
                    },
                    isNil
                )
                return {
                    nodeKey: node.key,
                    provider,
                    label: resolveI18nText(meta?.label, provider),
                    description: resolveI18nText(meta?.description),
                    ...(Object.keys(runtimeMeta).length ? { meta: runtimeMeta } : {}),
                    toolNames: Object.entries(entity?.tools ?? {})
                        .filter(([, enabled]) => enabled !== false)
                        .map(([name]) => name)
                }
            })
            .filter((item): item is NonNullable<typeof item> => !!item)

        const skills =
            hasSkillsMiddleware && xpert.workspaceId
                ? await this.getRuntimeSkills(xpert.workspaceId, defaultSkillSelection)
                : []

        return {
            skills,
            plugins
        }
    }

    private async getRuntimeSkills(workspaceId: string, defaultSelection: RuntimeSkillDefaultSelection) {
        const result = await this.skillPackageService.getAllByWorkspace(
            workspaceId,
            {
                relations: ['skillIndex', 'skillIndex.repository']
            } as any,
            false,
            RequestContext.currentUser()
        )

        return (result.items ?? []).map((skill) => {
            const skillIndex = skill.skillIndex
            const repositoryId = skillIndex?.repositoryId ?? skillIndex?.repository?.id
            const runtimeMeta = omitBy(
                {
                    icon: skill.metadata?.icon
                },
                isNil
            )
            const isDefault =
                defaultSelection.skillIds.has(skill.id) ||
                defaultSelection.repositoryDefaults.some(
                    (selection) =>
                        !!repositoryId &&
                        selection.repositoryId === repositoryId &&
                        !selection.disabledSkillIds.has(skill.id)
                )
            return {
                id: skill.id,
                workspaceId: skill.workspaceId,
                label: resolveI18nText(skill.name, skillIndex?.name ?? skillIndex?.skillId ?? skill.id),
                description: skillIndex?.description,
                repositoryName: skillIndex?.repository?.name,
                provider: skillIndex?.repository?.provider,
                ...(Object.keys(runtimeMeta).length ? { meta: runtimeMeta } : {}),
                ...(isDefault ? { default: true } : {})
            }
        })
    }
}

type RuntimeSkillDefaultSelection = {
    skillIds: Set<string>
    repositoryDefaults: Array<{
        repositoryId: string
        disabledSkillIds: Set<string>
    }>
}

function tryGetMiddlewareStrategy(agentMiddlewareRegistry: AgentMiddlewareRegistry, provider: string) {
    try {
        return agentMiddlewareRegistry.get(provider)
    } catch {
        return null
    }
}

function collectDefaultSkillSelection(
    middlewareNodes: ReturnType<typeof getAgentMiddlewareNodes>
): RuntimeSkillDefaultSelection {
    const skillIds = new Set<string>()
    const repositoryDefaults: RuntimeSkillDefaultSelection['repositoryDefaults'] = []

    for (const node of middlewareNodes) {
        const entity = node.entity as unknown as IWFNMiddleware
        if (normalizeMiddlewareProvider(entity?.provider) !== SKILLS_MIDDLEWARE_NAME) {
            continue
        }

        const options = asRecord(entity?.options)
        for (const id of normalizeStringArray(options?.skills)) {
            skillIds.add(id)
        }

        const repositoryDefault = asRecord(options?.repositoryDefault)
        const repositoryId = typeof repositoryDefault?.repositoryId === 'string'
            ? repositoryDefault.repositoryId.trim()
            : ''
        if (repositoryId) {
            repositoryDefaults.push({
                repositoryId,
                disabledSkillIds: new Set(normalizeStringArray(repositoryDefault?.disabledSkillIds))
            })
        }
    }

    return { skillIds, repositoryDefaults }
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return []
    }

    return Array.from(
        new Set(
            value
                .map((item) => (typeof item === 'string' ? item.trim() : ''))
                .filter((item) => item.length > 0)
        )
    )
}

function resolveI18nText(value: unknown, fallback = '') {
    if (typeof value === 'string') {
        return value
    }

    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>
        if (typeof record.zh_Hans === 'string' && record.zh_Hans.trim()) {
            return record.zh_Hans
        }
        if (typeof record.en_US === 'string' && record.en_US.trim()) {
            return record.en_US
        }
    }

    return fallback
}

function transformAssistant(xpert: IXpert) {
    const contextSize = getAssistantContextSize(xpert)
    const agentKey = getAssistantPrimaryAgentKey(xpert)
    const configurable = omitBy(
        {
            context_size: contextSize,
            agentKey
        },
        isNil
    )
    const config = omitBy(
        {
            ...pick(xpert, 'agentConfig', 'options', 'summarize', 'memory', 'features'),
            configurable: Object.keys(configurable).length ? configurable : undefined
        },
        isNil
    )

    return {
        assistant_id: xpert.id,
        graph_id: xpert.id,
        name: xpert.name,
        description: xpert.description,
        version: Number(xpert.version) || 0,
        created_at: xpert.createdAt.toISOString(),
        updated_at: xpert.updatedAt.toISOString(),
        config,
        metadata: omitBy(
            {
                workspaceId: xpert.workspaceId,
                avatar: xpert.avatar,
                slug: xpert.slug,
                type: xpert.type,
                title: xpert.title,
                tags: xpert.tags?.length ? xpert.tags : undefined,
                context_size: contextSize,
                agent_key: agentKey
            },
            isNil
        ),
        context: null
    } as Assistant
}

function transformMetadata2Where(metadata: Record<string, any> | undefined) {
    const where = {}
    if (metadata?.slug) {
        where['slug'] = metadata.slug
    }
    if (metadata?.workspaceId) {
        where['workspaceId'] = metadata.workspaceId
    }
    if (metadata?.type) {
        where['type'] = metadata.type
    }
    if (!isNil(metadata?.latest)) {
        where['latest'] = metadata.latest
    }
    if (!isNil(metadata?.version)) {
        where['version'] = metadata.version
    }
    return where
}

function getAssistantContextSize(xpert: IXpert): number | undefined {
    const effectiveCopilotModel = (xpert.agent?.copilotModel ?? xpert.copilotModel) as ICopilotModel
    return normalizeContextSize(effectiveCopilotModel?.options?.[ModelPropertyKey.CONTEXT_SIZE])
}

function getAssistantPrimaryAgentKey(xpert: IXpert): string | undefined {
    const key = xpert?.agent?.key
    if (typeof key !== 'string') {
        return
    }
    const normalized = key.trim()
    return normalized || undefined
}
