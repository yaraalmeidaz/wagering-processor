/** Marca o intervalo em que os repositórios podem usar a transação da unidade de trabalho. */
export class TransactionScope {
  #active = true;

  assertActive(): void {
    if (!this.#active) {
      throw new Error('repositório usado fora de uma unidade de trabalho');
    }
  }

  close(): void {
    this.#active = false;
  }
}
