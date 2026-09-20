import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { CreateClosureDto } from '../common/dto';
import { ClosuresService } from './closures.service';

@Controller('closures')
@UseGuards(AuthGuard)
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  /** 总务人员登记临时封闭：系统给出每个受影响活动的处置依据 */
  @Post()
  @Roles('staff')
  create(@Body() dto: CreateClosureDto, @CurrentUser() user: AuthUser) {
    return this.closures.registerClosure(
      dto.venueId,
      dto.startAt,
      dto.endAt,
      dto.reason,
      user.id,
    );
  }

  @Get()
  list(
    @CurrentUser() _user: AuthUser,
    @Query('venueId') venueId?: string,
  ) {
    return this.closures.listClosures(venueId);
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() _user: AuthUser) {
    return this.closures.getClosure(Number(id));
  }

  /** 活动负责人接受某条备选迁移方案 */
  @Post('proposals/:id/accept')
  accept(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.closures.acceptProposal(Number(id), user.id);
  }

  /** 活动负责人拒绝某条备选方案 */
  @Post('proposals/:id/reject')
  reject(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    this.closures.rejectProposal(Number(id), user.id);
    return { id: Number(id), status: 'rejected' };
  }
}
