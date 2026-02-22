import type {
  RuntimeMode,
  RuntimeModeHandler,
  RuntimeModeHandlerRegistrationOptions,
} from './runtimeModeContracts';

export class RuntimeModeHandlerRegistry {
  private handlers: RuntimeModeHandler[];

  constructor(initialHandlers: RuntimeModeHandler[] = []) {
    this.handlers = [...initialHandlers];
  }

  register(
    handler: RuntimeModeHandler,
    options: RuntimeModeHandlerRegistrationOptions = {}
  ): void {
    if (options.prepend) {
      this.handlers.unshift(handler);
      return;
    }
    this.handlers.push(handler);
  }

  registerMany(
    handlers: RuntimeModeHandler[],
    options: RuntimeModeHandlerRegistrationOptions = {}
  ): void {
    if (options.prepend) {
      this.handlers = [...handlers, ...this.handlers];
      return;
    }
    this.handlers.push(...handlers);
  }

  list(): RuntimeModeHandler[] {
    return [...this.handlers];
  }

  resolve(mode: RuntimeMode): RuntimeModeHandler | undefined {
    return this.handlers.find(candidate => candidate.supports(mode))
      || this.handlers.find(candidate => candidate.supports('initial'));
  }
}
