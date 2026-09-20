import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { BookingsService } from './bookings.service';
import { BookingViewService } from './booking-view.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { AuthGuard, CurrentUser } from '../common/auth';
import { AuthUser } from '../domain/types';
import { DomainError } from '../common/errors';
import {
  optionalBool,
  optionalString,
  optionalStringArray,
  requireBool,
  requireInt,
  requireIso,
  requireString,
  requireStringArray,
} from '../common/validate';

@Controller('bookings')
@UseGuards(AuthGuard)
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly view: BookingViewService,
    private readonly approvals: ApprovalsService,
  ) {}

  /**
   * 创建预约。支持 Idempotency-Key 请求头：网络重试/重复提交返回同一条记录，
   * 不会产生双重占用。
   */
  @Post()
  create(
    @Body() body: any,
    @CurrentUser() user: AuthUser,
    @Headers('idempotency-key') idemKey?: string,
  ) {
    const { booking, replayed } = this.bookings.create({
      ownerId: user.id,
      ownerName: optionalString(body, 'ownerName'),
      title: requireString(body, 'title'),
      attendees: requireInt(body, 'attendees', 1),
      requiresAccessibleRoute: optionalBool(body, 'requiresAccessibleRoute', false),
      requiredEquipment: optionalStringArray(body, 'requiredEquipment'),
      audienceGroups: requireStringArray(body, 'audienceGroups'),
      start: requireIso(body, 'start'),
      end: requireIso(body, 'end'),
      venueId: requireString(body, 'venueId'),
      idempotencyKey: idemKey ?? null,
    });
    return { ...this.view.render(booking), replayed };
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('ownerId') ownerId?: string,
    @Query('venueId') venueId?: string,
    @Query('status') status?: string,
  ) {
    // 负责人默认只能看到本人项目；总务/审批人可查看全部
    const effectiveOwner = user.role === 'organizer' ? user.id : ownerId;
    return this.bookings
      .list({ ownerId: effectiveOwner, venueId, status })
      .map((b) => this.view.render(b));
  }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const b = this.bookings.get(id);
    if (user.role === 'organizer' && b.ownerId !== user.id) {
      throw DomainError.forbidden('活动负责人只能查看本人项目');
    }
    return this.view.detail(id);
  }

  /** 负责人修改本人项目（仅 PENDING） */
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const patch: any = {};
    if (body?.title !== undefined) patch.title = requireString(body, 'title');
    if (body?.attendees !== undefined) patch.attendees = requireInt(body, 'attendees', 1);
    if (body?.requiresAccessibleRoute !== undefined) {
      patch.requiresAccessibleRoute = requireBool(body, 'requiresAccessibleRoute');
    }
    if (body?.requiredEquipment !== undefined) {
      patch.requiredEquipment = requireStringArray(body, 'requiredEquipment');
    }
    if (body?.audienceGroups !== undefined) {
      patch.audienceGroups = requireStringArray(body, 'audienceGroups');
    }
    if (body?.start !== undefined) patch.start = requireIso(body, 'start');
    if (body?.end !== undefined) patch.end = requireIso(body, 'end');
    if (body?.venueId !== undefined) patch.venueId = requireString(body, 'venueId');
    if (Object.keys(patch).length === 0) throw DomainError.badRequest('没有需要更新的字段');
    return this.view.render(this.bookings.update(id, patch, user));
  }

  /** 确认预约（幂等）。冲突时返回 409 及结构化冲突依据。 */
  @Post(':id/confirm')
  confirm(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    const result = this.bookings.confirm(id, user);
    return {
      ...this.view.render(result.booking),
      waivedViolations: result.violations,
      handoverIds: result.handoverIds,
    };
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    return this.view.render(this.bookings.cancel(id, user, optionalString(body ?? {}, 'reason') ?? undefined));
  }

  @Post(':id/check-in')
  checkIn(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.view.render(this.bookings.checkIn(id, user));
  }

  @Post(':id/complete')
  complete(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.view.render(this.bookings.complete(id, user));
  }

  /** 申请例外批准：FIRE_CAPACITY（消防容量）或 SPECIAL_ACCESS（特殊通行） */
  @Post(':id/exceptions')
  requestException(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const type = requireString(body, 'type');
    if (!['FIRE_CAPACITY', 'SPECIAL_ACCESS'].includes(type)) {
      throw DomainError.badRequest('type 只能为 FIRE_CAPACITY 或 SPECIAL_ACCESS');
    }
    return this.approvals.request(id, type as any, requireString(body, 'reason'), user.id);
  }
}
