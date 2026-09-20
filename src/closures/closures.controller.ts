import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ClosuresService } from './closures.service';
import { AuthGuard, CurrentUser, Roles } from '../common/auth';
import { AuthUser } from '../domain/types';
import { requireIso, requireString, optionalString } from '../common/validate';

@Controller('venues')
@UseGuards(AuthGuard)
export class ClosuresController {
  constructor(private readonly closures: ClosuresService) {}

  /** 总务临时封闭场地：自动计算影响、迁移可满足硬条件的预约、记录无法安置原因 */
  @Post(':venueId/closures')
  @Roles('staff')
  close(@Param('venueId') venueId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    return this.closures.closeVenue(venueId, {
      reason: requireString(body, 'reason'),
      from: requireIso(body, 'from'),
      to: requireIso(body, 'to'),
      actorId: user.id,
    });
  }

  @Get(':venueId/closures')
  list(@Param('venueId') venueId: string) {
    return this.closures.closuresOf(venueId).map((c) => ({
      ...c,
      impacts: this.closures.impactsOf(c.id),
    }));
  }

  /** 总务重开场地 */
  @Post(':venueId/reopen')
  @Roles('staff')
  reopen(@Param('venueId') venueId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    return this.closures.reopenVenue(venueId, user.id, optionalString(body ?? {}, 'reason') ?? '场地重新开放');
  }
}
