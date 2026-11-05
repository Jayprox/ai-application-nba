// Refusal raised by the real-run guard and the ledger. `code` is a short stable identifier.
export class GuardRefusal extends Error {
  constructor(code, why) {
    super(`refused (${code}): ${why}`);
    this.name = 'GuardRefusal';
    this.code = code;
  }
}
