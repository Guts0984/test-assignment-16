import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type ApiKeyPrincipal, type ShopUserPrincipal } from '../../common/auth/principal';
import { unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { CreateInboundDto, InboundDto, InboundListDto } from './dto/inbound.dto';
import { InboundService } from './inbound.service';

type ShopPrincipal = ShopUserPrincipal | ApiKeyPrincipal;

@ApiTags('shop')
@Controller('shop/v1/inbound')
export class InboundController {
  constructor(private readonly inbound: InboundService) {}

  @Post()
  @ShopAccess()
  @Created(InboundDto)
  @ApiProtectedErrors(404, 409, 422)
  async create(@CurrentPrincipal() p: ShopPrincipal, @Body() b: CreateInboundDto) {
    return unwrap(await this.inbound.create(p.shopId, b));
  }

  @Get()
  @ShopAccess()
  @Ok(InboundListDto)
  @ApiProtectedErrors()
  list(@CurrentPrincipal() p: ShopPrincipal) {
    return this.inbound.list(p.shopId);
  }

  @Get(':id')
  @ShopAccess()
  @Ok(InboundDto)
  @ApiProtectedErrors(404)
  async get(@CurrentPrincipal() p: ShopPrincipal, @Param('id', UUID) id: string) {
    return unwrap(await this.inbound.get(p.shopId, id));
  }
}
