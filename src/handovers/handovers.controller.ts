import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { HandoversService } from './handovers.service';
import { AuthGuard, CurrentUser } from '../common/auth';
import { AuthUser } from '../domain/types';
import { DomainError } from '../common/errors';

@Controller('handovers')
@UseGuards(AuthGuard)
export class HandoversController {
  constructor(private readonly handovers: HandoversService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.handovers.get(id);
  }

  /** 前责任人确认清场完成；可传 { items: [...] } 逐项勾选 */
  @Post(':id/confirm-out')
  confirmOut(@Param('id') id: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    const items = body?.items;
    if (items !== undefined && (!Array.isArray(items) || items.some((x) => typeof x !== 'string'))) {
      throw DomainError.badRequest('items 必须为字符串数组');
    }
    return this.handovers.confirmOut(id, user.id, items);
  }

  /** 后责任人确认接收 */
  @Post(':id/confirm-in')
  confirmIn(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    return this.handovers.confirmIn(id, user.id);
  }
}
