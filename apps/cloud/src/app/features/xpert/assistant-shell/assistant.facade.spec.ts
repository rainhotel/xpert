import { signal, type WritableSignal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { Router } from '@angular/router'
import { AppService } from '../../../app.service'
import { of, Subject } from 'rxjs'
import { type AssistantContext, type AssistantStudioRuntimeContext, XpertAssistantFacade } from './assistant.facade'

jest.mock('../../../app.service', () => ({
  AppService: class AppService {}
}))

jest.mock('../../../@core', () => {
  return {
    AiThreadService: class AiThreadService {},
    AssistantCode: {
      CHAT_COMMON: 'chat_common',
      XPERT_SHARED: 'xpert_shared',
      CHATBI: 'chatbi'
    },
    AssistantBindingSourceScope: {
      NONE: 'none',
      TENANT: 'tenant',
      ORGANIZATION: 'organization'
    },
    CHAT_EVENT_TYPE_THREAD_CONTEXT_USAGE: 'thread_context_usage',
    appendMessagePlainText: (accumulator: string, incoming: string, context?: { joinHint?: string }) => {
      const separator = accumulator && context?.joinHint !== 'none' ? '\n' : ''
      return `${accumulator}${separator}${incoming}`
    },
    ChatMessageEventTypeEnum: {
      ON_MESSAGE_START: 'on_message_start'
    },
    ChatMessageTypeEnum: {
      EVENT: 'event',
      MESSAGE: 'message'
    },
    ChatConversationService: class ChatConversationService {},
    ChatMessageService: class ChatMessageService {},
    createMessageAppendContextTracker: () => {
      let previousStreamId: string | null = null

      return {
        resolve: (options: { fallbackStreamId?: string }) => {
          const streamId = options.fallbackStreamId ?? null
          const shouldJoin = !!streamId && streamId === previousStreamId
          previousStreamId = streamId

          return {
            appendContext: { streamId },
            messageContext: shouldJoin ? { streamId, joinHint: 'none' } : { streamId }
          }
        },
        reset: () => {
          previousStreamId = null
        },
        current: () => (previousStreamId ? { streamId: previousStreamId } : null)
      }
    },
    filterMessageText: (content: unknown) => {
      if (typeof content === 'string') {
        return content
      }
      if (Array.isArray(content)) {
        return content
          .map((item) => (typeof item?.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n')
      }
      return null
    },
    OrderTypeEnum: {
      DESC: 'DESC',
      ASC: 'ASC'
    },
    XpertAPIService: class XpertAPIService {}
  }
})

jest.mock('@xpert-ai/cloud/state', () => ({
  injectWorkspace: () => () => ({ id: 'selected-workspace' })
}))

jest.mock('../../assistant/assistant-chatkit.runtime', () => {
  const { signal } = jest.requireActual('@angular/core')

  const runtimeState = {
    control: signal(null),
    config: signal(null),
    loading: signal(false),
    status: signal('missing'),
    isConfigured: signal(false)
  }

  return {
    injectAssistantChatkitRuntime: () => runtimeState,
    __runtimeState: runtimeState
  }
})

type RuntimeStateMock = {
  control: WritableSignal<unknown>
  config: WritableSignal<unknown>
  loading: WritableSignal<boolean>
  status: WritableSignal<string>
  isConfigured: WritableSignal<boolean>
}

type RequestContextFacade = {
  buildRequestContext(
    context: AssistantContext,
    studioRuntimeContext?: AssistantStudioRuntimeContext | null
  ): Record<string, unknown>
}

type ThreadServiceMock = {
  getThread: jest.Mock
}

type ConversationServiceMock = {
  getById: jest.Mock
  getByThreadId: jest.Mock
}

type MessageServiceMock = {
  getAllInOrg: jest.Mock
}

const runtimeState = (
  jest.requireMock('../../assistant/assistant-chatkit.runtime') as {
    __runtimeState: RuntimeStateMock
  }
).__runtimeState
const {
  AiThreadService,
  AssistantBindingSourceScope,
  AssistantCode,
  ChatConversationService,
  ChatMessageService,
  XpertAPIService
} = jest.requireMock('../../../@core') as {
  AiThreadService: new () => unknown
  AssistantCode: {
    CHAT_COMMON: string
    XPERT_SHARED: string
    CHATBI: string
  }
  AssistantBindingSourceScope: {
    NONE: string
    TENANT: string
    ORGANIZATION: string
  }
  ChatConversationService: new () => unknown
  ChatMessageService: new () => unknown
  XpertAPIService: new () => unknown
}

function exposeRequestContext(facade: XpertAssistantFacade) {
  return facade as unknown as RequestContextFacade
}

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('XpertAssistantFacade', () => {
  const createFacade = (url: string) => {
    const routerEvents$ = new Subject<unknown>()
    const router = {
      url,
      events: routerEvents$.asObservable(),
      navigate: jest.fn().mockResolvedValue(true)
    }
    const threadService: ThreadServiceMock = {
      getThread: jest.fn().mockReturnValue(of({ thread_id: 'thread-1', metadata: { id: 'conversation-1' } }))
    }
    const conversationService: ConversationServiceMock = {
      getById: jest.fn().mockReturnValue(of(null)),
      getByThreadId: jest.fn().mockReturnValue(of(null))
    }
    const messageService: MessageServiceMock = {
      getAllInOrg: jest.fn().mockReturnValue(of({ items: [], total: 0 }))
    }

    TestBed.resetTestingModule()
    TestBed.configureTestingModule({
      providers: [
        XpertAssistantFacade,
        {
          provide: Router,
          useValue: router
        },
        {
          provide: AppService,
          useValue: {
            isMobile: signal(false),
            lang: signal('en'),
            theme$: signal({ primary: 'light' })
          }
        },
        {
          provide: XpertAPIService,
          useValue: {
            getTeam: jest.fn().mockReturnValue(of({ workspaceId: 'workspace-from-team' }))
          }
        },
        {
          provide: AiThreadService,
          useValue: threadService
        },
        {
          provide: ChatConversationService,
          useValue: conversationService
        },
        {
          provide: ChatMessageService,
          useValue: messageService
        }
      ]
    })

    return {
      conversationService,
      messageService,
      router,
      threadService,
      facade: TestBed.inject(XpertAssistantFacade)
    }
  }

  beforeEach(() => {
    runtimeState.control.set(null)
    runtimeState.config.set(null)
    runtimeState.loading.set(false)
    runtimeState.status.set('missing')
    runtimeState.isConfigured.set(false)
  })

  afterEach(() => {
    jest.useRealTimers()
    TestBed.resetTestingModule()
    jest.clearAllMocks()
  })

  it('omits env.xpertId on workspace routes', () => {
    const { facade } = createFacade('/xpert/w/workspace-1')

    const requestContext = exposeRequestContext(facade).buildRequestContext({
      workspaceId: 'workspace-1',
      xpertId: null
    })

    expect(requestContext).toEqual({
      env: {
        workspaceId: 'workspace-1'
      }
    })
  })

  it('includes env.xpertId and studio runtime fields on studio routes', () => {
    const { facade } = createFacade('/xpert/x/xpert-1/agents')

    const requestContext = exposeRequestContext(facade).buildRequestContext(
      {
        workspaceId: 'workspace-1',
        xpertId: 'xpert-1'
      },
      {
        targetXpertId: 'xpert-1',
        baseDraftHash: 'hash-from-pristine',
        unsaved: true
      }
    )

    expect(requestContext).toEqual({
      env: {
        workspaceId: 'workspace-1',
        xpertId: 'xpert-1'
      },
      targetXpertId: 'xpert-1',
      baseDraftHash: 'hash-from-pristine',
      unsaved: true
    })
  })

  it('reads assistant id from the unified runtime config when configured', () => {
    const { facade } = createFacade('/xpert/x/xpert-1/agents')

    runtimeState.config.set({
      code: AssistantCode.XPERT_SHARED,
      enabled: true,
      assistantId: 'assistant-1',
      tenantId: 'tenant-1',
      organizationId: null,
      sourceScope: AssistantBindingSourceScope.TENANT
    })
    runtimeState.isConfigured.set(true)
    runtimeState.status.set('ready')

    expect(facade.assistantId()).toBe('assistant-1')
  })

  it('returns null assistant id when the runtime is not configured', () => {
    const { facade } = createFacade('/xpert/x/xpert-1/agents')

    expect(facade.assistantId()).toBeNull()
  })

  it('navigates to prompt workflows and emits refresh after authoring tool effects', async () => {
    const { facade, router } = createFacade('/xpert/w/workspace-1')

    facade.setOpen(true)
    facade.handleEffect({
      name: 'refresh_prompt_workflows',
      data: {
        workspaceId: 'workspace-1',
        workflowId: 'workflow-1',
        key: 'review',
        operation: 'updated'
      }
    })

    expect(router.navigate).toHaveBeenCalledWith(['/xpert/w', 'workspace-1', 'prompt-workflows'])
    await router.navigate.mock.results[0].value
    await Promise.resolve()

    expect(facade.open()).toBe(false)
    expect(facade.promptWorkflowRefresh()).toEqual(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        workflowId: 'workflow-1',
        key: 'review',
        operation: 'updated'
      })
    )
  })

  it('ignores prompt workflow effects without workspace id', () => {
    const { facade, router } = createFacade('/xpert/w/workspace-1')

    facade.handleEffect({
      name: 'refresh_prompt_workflows',
      data: {
        key: 'review'
      }
    })

    expect(router.navigate).not.toHaveBeenCalled()
    expect(facade.promptWorkflowRefresh()).toBeNull()
  })

  it('navigates to workspace skills and emits refresh after skill authoring effects', async () => {
    const { facade, router } = createFacade('/xpert/w/workspace-1')

    facade.setOpen(true)
    facade.handleEffect({
      name: 'refresh_workspace_skills',
      data: {
        workspaceId: 'workspace-1',
        skillId: 'skill-1',
        operation: 'created'
      }
    })

    expect(router.navigate).toHaveBeenCalledWith(['/xpert/w', 'workspace-1', 'skills'])
    await router.navigate.mock.results[0].value
    await Promise.resolve()

    expect(facade.open()).toBe(true)
    expect(facade.workspaceSkillRefresh()).toEqual(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        skillId: 'skill-1',
        operation: 'created'
      })
    )
  })

  it('updates preview text from streaming message chunks by message id', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Current conversation',
        status: 'idle'
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()
    conversationService.getById.mockClear()

    facade.handleResponseStart()
    facade.handleLog({
      name: 'thread.item.event',
      data: {
        type: 'event',
        event: 'on_message_start',
        data: {
          id: 'message-1'
        }
      }
    })
    facade.handleLog({
      name: 'thread.item.message',
      data: {
        type: 'message',
        data: 'Hel'
      }
    })
    facade.handleLog({
      name: 'thread.item.message',
      data: {
        type: 'message',
        data: {
          type: 'text',
          id: 'message-1',
          text: 'lo'
        }
      }
    })

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        latestAiMessageText: 'Hello',
        status: 'busy'
      })
    )

    facade.handleLog({
      name: 'thread.item.message',
      data: {
        type: 'message',
        data: {
          type: 'text',
          id: 'message-2',
          text: 'Next'
        }
      }
    })

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        latestAiMessageText: 'Next',
        status: 'busy'
      })
    )
    expect(conversationService.getById).not.toHaveBeenCalled()
  })

  it('updates preview usage from thread context usage log events', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Current conversation',
        status: 'idle'
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()
    conversationService.getById.mockClear()

    facade.handleResponseStart()
    facade.handleLog({
      name: 'lg.chat.event',
      data: {
        runId: 'run-1',
        threadId: 'thread-1',
        type: 'thread_context_usage',
        agentKey: 'Agent_PlatformChatKitAuthoring',
        updatedAt: '2026-05-04T15:07:31.026Z',
        usage: {
          contextTokens: 17984,
          inputTokens: 17984,
          outputTokens: 1626,
          totalTokens: 19610,
          embedTokens: 0,
          totalPrice: 0.022192,
          currency: 'RMB'
        }
      }
    })

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        status: 'busy',
        usage: expect.objectContaining({
          threadId: 'thread-1',
          agentKey: 'Agent_PlatformChatKitAuthoring',
          contextTokens: 17984,
          totalTokens: 19610,
          totalPrice: 0.022192,
          currency: 'RMB'
        })
      })
    )
    expect(conversationService.getById).not.toHaveBeenCalled()
  })

  it('uses the conversation start input summary as a temporary title', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: null,
        status: 'idle'
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()
    conversationService.getById.mockClear()

    facade.handleResponseStart()
    facade.handleLog({
      name: 'lg.conversation.start',
      data: {
        runId: 'run-1',
        threadId: 'thread-1',
        inputSummary: JSON.stringify({
          input: {
            input: 'Create a company launch checklist'
          }
        })
      }
    })
    await flushPromises()

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        title: 'Create a company launch checklist',
        status: 'busy'
      })
    )

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Company launch',
        status: 'idle'
      })
    )
    facade.handleResponseEnd()
    await flushPromises()

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        title: 'Company launch',
        status: 'idle'
      })
    )
  })

  it('uses the nested human input from conversation parameters as title', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: null,
        status: 'idle',
        options: {
          parameters: {
            input: '{"input":{"input":"Delete newly created skills","runtime'
          }
        }
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()

    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        title: 'Delete newly created skills'
      })
    )
  })

  it('fetches the latest ai message on conversation end and previews its last two lines', async () => {
    const { conversationService, facade, messageService } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Current conversation',
        status: 'idle'
      })
    )
    messageService.getAllInOrg.mockReturnValue(
      of({
        items: [
          {
            id: 'message-1',
            conversationId: 'conversation-1',
            role: 'ai',
            content: 'First line\nSecond line\nThird line'
          }
        ],
        total: 1
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()
    messageService.getAllInOrg.mockClear()

    facade.handleResponseStart()
    facade.handleLog({
      name: 'lg.conversation.end',
      data: {
        runId: 'run-1',
        threadId: 'thread-1'
      }
    })
    await flushPromises()

    expect(messageService.getAllInOrg).toHaveBeenCalledWith({
      where: {
        conversationId: 'conversation-1',
        role: 'ai'
      },
      order: {
        createdAt: 'DESC'
      },
      take: 1
    })
    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        latestAiMessageText: 'Second line\nThird line',
        status: 'busy'
      })
    )
  })

  it('ignores bottom-layer SSE strings and non-text ChatKit logs', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Current conversation',
        status: 'idle'
      })
    )
    facade.handleThreadChange('thread-1')
    await flushPromises()
    conversationService.getById.mockClear()

    facade.handleResponseStart()
    facade.handleLog({
      name: 'component',
      data: {
        id: 'component-1',
        type: 'component',
        data: {
          title: 'Tool output',
          status: 'running'
        }
      }
    })
    facade.handleLog({
      name: 'thread.item.message',
      data: JSON.stringify({
        type: 'message',
        data: {
          type: 'reasoning',
          text: '用户实现',
          id: 'chatcmpl-72bc6088-1d92-9ed7-84e6-e173720df711',
          created_date: '2026-05-04T14:47:02.120Z'
        }
      })
    })

    expect(facade.conversationPreview()?.latestAiMessageText).toBeNull()
    expect(conversationService.getById).not.toHaveBeenCalled()
  })

  it('keeps streamed preview text after response end without loading message relations', async () => {
    const { conversationService, facade } = createFacade('/xpert/w/workspace-1')

    conversationService.getById.mockReturnValue(
      of({
        id: 'conversation-1',
        title: 'Current conversation',
        status: 'idle'
      })
    )
    facade.handleThreadLoadStart('thread-1')
    facade.handleResponseStart()
    await flushPromises()

    expect(conversationService.getById).toHaveBeenLastCalledWith('conversation-1')
    conversationService.getById.mockClear()

    facade.handleLog({
      name: 'thread.item.message',
      data: {
        type: 'message',
        data: {
          type: 'text',
          id: 'message-1',
          text: 'Done'
        }
      }
    })
    facade.handleResponseEnd()
    await flushPromises()

    expect(conversationService.getById).toHaveBeenLastCalledWith('conversation-1')
    expect(conversationService.getById).not.toHaveBeenCalledWith('conversation-1', { relations: ['messages'] })
    expect(facade.conversationPreview()).toEqual(
      expect.objectContaining({
        latestAiMessageText: 'Done',
        status: 'idle'
      })
    )
  })
})
