import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApprovalsService } from './approvals.service';
import { AuthGuard, CurrentUser, Roles } from '../common/auth';
import { AuthUser } from '../domain/types';
import { DomainError } from '../common/errors';

@Controller('approvals')
@UseGuards(AuthGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  @Roles('approver', 'staff')
  list(@Query('status') status?: string, @Query('bookingId') bookingId?: string) {
    if (status && !['PENDING', 'APPROVED', 'REJECTED'].includes(status)) {
      throw DomainError.badRequest('status 只能为 PENDING / APPROVED / REJECTED');
    }
    return this.approvals.list({ status, bookingId });
  }

  @Post(':id/approve')
  @Roles('approver')
  approve(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.approvals.decide(id, true, user.id);
  }

  @Post(':id/reject')
  @Roles('approver')
  reject(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.approvals.decide(id, false, user.id);
  }
}
