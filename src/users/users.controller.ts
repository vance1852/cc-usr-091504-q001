import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { AuthGuard, AuthUser } from '../common/auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import { Roles } from '../common/roles.decorator';
import { CreateUserDto } from '../common/dto';
import { UsersService } from './users.service';

@Controller('users')
@UseGuards(AuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /** 用户登记由总务人员负责 */
  @Post()
  @Roles('staff')
  create(@Body() dto: CreateUserDto) {
    this.users.upsert(dto.id, dto.name, dto.role);
    return { id: dto.id, name: dto.name, role: dto.role };
  }

  @Get()
  list(@CurrentUser() _user: AuthUser) {
    return this.users.list();
  }
}
