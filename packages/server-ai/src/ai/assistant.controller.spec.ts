import { WorkflowNodeTypeEnum } from '@xpert-ai/contracts'

jest.mock('../assistant-binding', () => ({
    AssistantBindingService: class {}
}))
jest.mock('../xpert', () => ({
    PublishedXpertAccessService: class {}
}))
jest.mock('../skill-package', () => ({
    SkillPackageService: class {}
}))

import { AssistantsController } from './assistant.controller'

describe('AssistantsController', () => {
    it('hides required middleware nodes from runtime plugin capabilities', async () => {
        const publishedXpertAccessService = {
            getAccessiblePublishedXpert: jest.fn(async () => ({
                id: 'assistant-1',
                workspaceId: 'workspace-1',
                agent: {
                    key: 'agent-1'
                },
                graph: {
                    nodes: [
                        {
                            key: 'skills-middleware',
                            type: 'workflow',
                            entity: {
                                type: WorkflowNodeTypeEnum.MIDDLEWARE,
                                provider: 'skillsMiddleware',
                                options: {
                                    skills: ['skill-default'],
                                    repositoryDefault: {
                                        repositoryId: 'repo-default',
                                        disabledSkillIds: ['skill-repo-disabled']
                                    }
                                }
                            }
                        },
                        {
                            key: 'required-middleware',
                            type: 'workflow',
                            entity: {
                                type: WorkflowNodeTypeEnum.MIDDLEWARE,
                                provider: 'provider-a',
                                required: true
                            }
                        },
                        {
                            key: 'optional-middleware',
                            type: 'workflow',
                            entity: {
                                type: WorkflowNodeTypeEnum.MIDDLEWARE,
                                provider: 'provider-b',
                                tools: {
                                    visible: true,
                                    hidden: false
                                }
                            }
                        }
                    ],
                    connections: [
                        { type: 'workflow', from: 'agent-1', to: 'skills-middleware' },
                        { type: 'workflow', from: 'agent-1', to: 'required-middleware' },
                        { type: 'workflow', from: 'agent-1', to: 'optional-middleware' }
                    ]
                }
            }))
        }
        const assistantBindingService = {
            isEffectiveSystemAssistantId: jest.fn(async () => false)
        }
        const agentMiddlewareRegistry = {
            get: jest.fn((provider: string) => ({
                meta: {
                    label: {
                        en_US: provider === 'provider-b' ? 'Provider B' : 'Provider A'
                    },
                    description: {
                        en_US: `${provider} description`
                    },
                    icon: {
                        type: 'svg',
                        value: `<svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" /></svg>`,
                        color: '#00d2e6'
                    }
                }
            }))
        }
        const skillPackageService = {
            getAllByWorkspace: jest.fn(async () => ({
                items: [
                    {
                        id: 'skill-default',
                        workspaceId: 'workspace-1',
                        name: 'Default Skill',
                        metadata: {
                            icon: {
                                type: 'svg',
                                value: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg>`,
                                alt: 'Default Skill'
                            }
                        },
                        skillIndex: {
                            name: 'Default Skill',
                            description: 'Loaded by default',
                            repositoryId: 'repo-explicit',
                            repository: {
                                id: 'repo-explicit',
                                name: 'Explicit repo',
                                provider: 'github'
                            }
                        }
                    },
                    {
                        id: 'skill-repo-default',
                        workspaceId: 'workspace-1',
                        name: 'Repository Default Skill',
                        skillIndex: {
                            name: 'Repository Default Skill',
                            description: 'Loaded by repository default',
                            repositoryId: 'repo-default',
                            repository: {
                                id: 'repo-default',
                                name: 'Default repo',
                                provider: 'github'
                            }
                        }
                    },
                    {
                        id: 'skill-repo-disabled',
                        workspaceId: 'workspace-1',
                        name: 'Disabled Repository Skill',
                        skillIndex: {
                            name: 'Disabled Repository Skill',
                            repositoryId: 'repo-default',
                            repository: {
                                id: 'repo-default',
                                name: 'Default repo',
                                provider: 'github'
                            }
                        }
                    }
                ]
            }))
        }

        const controller = new AssistantsController(
            publishedXpertAccessService as any,
            assistantBindingService as any,
            agentMiddlewareRegistry as any,
            skillPackageService as any
        )

        await expect(controller.getRuntimeCapabilities('assistant-1')).resolves.toEqual({
            skills: [
                {
                    id: 'skill-default',
                    workspaceId: 'workspace-1',
                    label: 'Default Skill',
                    description: 'Loaded by default',
                    repositoryName: 'Explicit repo',
                    provider: 'github',
                    meta: {
                        icon: {
                            type: 'svg',
                            value: `<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /></svg>`,
                            alt: 'Default Skill'
                        }
                    },
                    default: true
                },
                {
                    id: 'skill-repo-default',
                    workspaceId: 'workspace-1',
                    label: 'Repository Default Skill',
                    description: 'Loaded by repository default',
                    repositoryName: 'Default repo',
                    provider: 'github',
                    default: true
                },
                {
                    id: 'skill-repo-disabled',
                    workspaceId: 'workspace-1',
                    label: 'Disabled Repository Skill',
                    description: undefined,
                    repositoryName: 'Default repo',
                    provider: 'github'
                }
            ],
            plugins: [
                {
                    nodeKey: 'optional-middleware',
                    provider: 'provider-b',
                    label: 'Provider B',
                    description: 'provider-b description',
                    meta: {
                        icon: {
                            type: 'svg',
                            value: `<svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" /></svg>`,
                            color: '#00d2e6'
                        }
                    },
                    toolNames: ['visible']
                }
            ]
        })
        expect(agentMiddlewareRegistry.get).toHaveBeenCalledTimes(1)
        expect(agentMiddlewareRegistry.get).toHaveBeenCalledWith('provider-b')
    })
})
