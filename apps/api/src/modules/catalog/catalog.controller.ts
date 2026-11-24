import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ShopAccess } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type ApiKeyPrincipal, type ShopUserPrincipal } from '../../common/auth/principal';
import { unwrap } from '../../common/errors';
import { ApiProtectedErrors, Created, Ok } from '../../common/openapi.decorator';
import { UUID } from '../../common/uuid.pipe';
import { CatalogService } from './catalog.service';
import { CreateSkuDto, SkuDto, SkuPageDto, SkuQueryDto, UpdateSkuDto } from './dto/catalog.dto';

type ShopPrincipal = ShopUserPrincipal | ApiKeyPrincipal;

@ApiTags('shop')
@Controller('shop/v1/skus')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Post()
  @ShopAccess()
  @Created(SkuDto)
  @ApiProtectedErrors(409)
  async create(@CurrentPrincipal() p: ShopPrincipal, @Body() b: CreateSkuDto) {
    return unwrap(await this.catalog.create(p.shopId, b));
  }

  @Get()
  @ShopAccess()
  @Ok(SkuPageDto)
  @ApiProtectedErrors()
  list(@CurrentPrincipal() p: ShopPrincipal, @Query() q: SkuQueryDto) {
    return this.catalog.page(p.shopId, q);
  }

  @Get(':id')
  @ShopAccess()
  @Ok(SkuDto)
  @ApiProtectedErrors(404)
  async get(@CurrentPrincipal() p: ShopPrincipal, @Param('id', UUID) id: string) {
    return unwrap(await this.catalog.get(p.shopId, id));
  }

  @Patch(':id')
  @ShopAccess()
  @Ok(SkuDto)
  @ApiProtectedErrors(404)
  async update(@CurrentPrincipal() p: ShopPrincipal, @Param('id', UUID) id: string, @Body() b: UpdateSkuDto) {
    return unwrap(await this.catalog.update(p.shopId, id, b));
  }
}
