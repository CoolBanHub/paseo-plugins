import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderConnection, ProviderConnectRequest, ProviderInput, ProviderRegistration } from "@getpaseo/plugin/server/provider";

export interface DshSessionLaunchContext {
  cwd: string;
  mode?: string;
  settings?: Readonly<Record<string, unknown>>;
}

const launchContext = new AsyncLocalStorage<DshSessionLaunchContext>();

export function currentDshSessionLaunchContext(): DshSessionLaunchContext | undefined {
  return launchContext.getStore();
}

/** Carry Paseo's selected workspace mode into the ACP process spawned during session.open. */
export function withDshSessionLaunchContext(provider: ProviderRegistration): ProviderRegistration {
  return {
    ...provider,
    async connect(request: ProviderConnectRequest): Promise<ProviderConnection> {
      const connection = await provider.connect(request);
      return {
        version: connection.version,
        capabilities: connection.capabilities,
        onEvent: (listener) => connection.onEvent(listener),
        close: () => connection.close(),
        send(input: ProviderInput) {
          if (input.type !== "session.open") return connection.send(input);
          return launchContext.run(
            { cwd: input.config.cwd, mode: input.config.mode, settings: input.config.settings },
            () => connection.send(input),
          );
        },
      };
    },
  };
}
