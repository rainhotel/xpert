import { Module } from '@nestjs/common'
import { HumanInTheLoopMiddleware } from './human-in-the-loop.middleware'

@Module({
    providers: [HumanInTheLoopMiddleware],
    exports: [HumanInTheLoopMiddleware]
})
export class XpertMiddlewareModule {}
