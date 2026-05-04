import { signal } from '@angular/core'
import { TestBed } from '@angular/core/testing'
import { Router } from '@angular/router'
import { AppService } from 'apps/cloud/src/app/app.service'
import { of, Subject } from 'rxjs'
import { XpertAssistantFacade } from './assistant.facade'

jest.mock('apps/cloud/src/app/app.service', () => ({
  AppService: class AppService {}
}))

jest.mock('apps/cloud/src/app/@core', () => {
  return {
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
    XpertAPIService: class XpertAPIService {}
  }
})

jest.mock('@xpert-ai/cloud/state', () => ({
  injectWorkspace: () => (() => ({ id: 'selected-workspace' }))
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

const runtimeState = jest.requireMock('../../assistant/assistant-chatkit.runtime').__runtimeState as any
const { AssistantBindingSourceScope, AssistantCode, XpertAPIService } = jest.requireMock(
  'apps/cloud/src/app/@core'
) as {
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
  XpertAPIService: new (...args: any[]) => unknown
}

describe('XpertAssistantFacade', () => {
  const createFacade = (url: string) => {
    const routerEvents$ = new Subject<unknown>()
    const router = {
      url,
      events: routerEvents$.asObservable(),
      navigate: jest.fn().mockResolvedValue(true)
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
        }
      ]
    })

    return {
      router,
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
    TestBed.resetTestingModule()
    jest.clearAllMocks()
  })

  it('omits env.xpertId on workspace routes', () => {
    const { facade } = createFacade('/xpert/w/workspace-1')

    const requestContext = (facade as any).buildRequestContext({
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

    const requestContext = (facade as any).buildRequestContext(
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
    } as any)

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
    } as any)

    expect(router.navigate).not.toHaveBeenCalled()
    expect(facade.promptWorkflowRefresh()).toBeNull()
  })

  it('navigates to workspace skills and emits refresh after skill authoring effects', async () => {
    const { facade, router } = createFacade('/xpert/w/workspace-1')

    facade.handleEffect({
      name: 'refresh_workspace_skills',
      data: {
        workspaceId: 'workspace-1',
        skillId: 'skill-1',
        operation: 'created'
      }
    } as any)

    expect(router.navigate).toHaveBeenCalledWith(['/xpert/w', 'workspace-1', 'skills'])
    await router.navigate.mock.results[0].value
    await Promise.resolve()

    expect(facade.workspaceSkillRefresh()).toEqual(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        skillId: 'skill-1',
        operation: 'created'
      })
    )
  })
})
