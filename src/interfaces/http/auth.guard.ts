import { type CanActivate, Injectable } from '@nestjs/common';

/**
 * Ponto de extensão da autenticação (ADR-0008). Hoje aceita toda requisição.
 * Aplicado só aos endpoints de negócio; os de health ficam fora (AGENTS.md §10).
 * Uma autenticação real (API key, JWT, mTLS) entra aqui, sem mudar controllers.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
