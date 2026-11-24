import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { type Request, type Response } from 'express';
import { AnyPrincipal, Public, RateLimit } from '../../common/auth/access.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { type Principal } from '../../common/auth/principal';
import { unwrap } from '../../common/errors';
import { ApiErrors, ApiProtectedErrors, Ok } from '../../common/openapi.decorator';
import { AuthService, type Session } from './auth.service';
import { LoginDto, MeDto, RefreshDto, SessionDto } from './dto/auth.dto';
import { toMe } from './domain/me';
import { REFRESH_COOKIE, refreshCookieOptions } from './domain/cookie';
import { ENV } from '../../infra/tokens';
import { type ApiEnv } from '../../config/env';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: ApiEnv,
  ) {}

  @Post('login')
  @HttpCode(200)
  @Public()
  @RateLimit('login')
  @Ok(SessionDto)
  @ApiErrors(401)
  async login(@Body() body: LoginDto, @Res({ passthrough: true }) res: Response): Promise<SessionDto> {
    return this.session(unwrap(await this.auth.login(body.email, body.password)), res);
  }

  @Post('refresh')
  @HttpCode(200)
  @Public()
  @RateLimit('login')
  @Ok(SessionDto)
  @ApiErrors(401)
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionDto> {
    const token = body.refreshToken ?? (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    return this.session(unwrap(await this.auth.refresh(token)), res);
  }

  @Post('logout')
  @HttpCode(204)
  @Public()
  @ApiErrors()
  async logout(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(
      body.refreshToken ?? (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE],
    );
    res.clearCookie(REFRESH_COOKIE, refreshCookieOptions(this.env));
  }

  @Get('me')
  @AnyPrincipal()
  @Ok(MeDto)
  @ApiProtectedErrors()
  me(@CurrentPrincipal() p: Principal): MeDto {
    return toMe(p);
  }

  private session(s: Session, res: Response): SessionDto {
    res.cookie(REFRESH_COOKIE, s.refreshToken, {
      ...refreshCookieOptions(this.env),
      maxAge: this.env.JWT_REFRESH_TTL_SEC * 1000,
    });
    return {
      accessToken: s.accessToken,
      expiresIn: s.expiresIn,
      refreshToken: s.refreshToken,
      me: toMe(s.principal),
    };
  }
}
