/** Formato aceito no X-Correlation-Id: restrito para não injetar conteúdo no log (ADR-0009). */
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** correlationId da requisição: o header, se válido; senão, um UUID novo (ADR-0009). */
export function correlationIdOf(header: string | undefined): string {
  return header !== undefined && CORRELATION_ID.test(header) ? header : crypto.randomUUID();
}
