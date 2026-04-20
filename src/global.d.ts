declare namespace ioBroker {
  interface State {
    val: any;
    ack: boolean;
    ts?: number;
    lc?: number;
    from?: string;
  }

  interface Message {
    command: string;
    message: any;
    from: string;
    callback?: { id: number; ack: boolean; time: number };
  }

  interface AdapterOptions {
    name: string;
  }

  interface ObjectCommon {
    name: string | Record<string, string>;
    type?: string;
    role?: string;
    read?: boolean;
    write?: boolean;
    def?: any;
    unit?: string;
  }

  interface SettableState {
    val: any;
    ack: boolean;
  }

  class Adapter {
    namespace: string;
    instance: number;
    config: Record<string, any>;
    log: {
      info(msg: string): void;
      warn(msg: string): void;
      error(msg: string): void;
      debug(msg: string): void;
    };
    constructor(options: AdapterOptions);
    on(event: 'ready', handler: () => void | Promise<void>): void;
    on(event: 'stateChange', handler: (id: string, state: State | null | undefined) => void | Promise<void>): void;
    on(event: 'message', handler: (obj: Message) => void | Promise<void>): void;
    on(event: 'unload', handler: (callback: () => void) => void): void;
    subscribeStates(pattern: string): Promise<void>;
    subscribeForeignStates(id: string): Promise<void>;
    extendObject(id: string, obj: Record<string, any>): Promise<void>;
    setState(id: string, state: any, cb?: (err?: Error | null) => void): void;
    setStateChanged(id: string, state: any, cb?: (err?: Error | null) => void): void;
    setStateAsync(id: string, state: any): Promise<void>;
    setStateChangedAsync(id: string, state: any): Promise<void>;
    getStateAsync(id: string): Promise<State | null | undefined>;
    sendTo(target: string, command: string, message: any, callback?: (result?: any) => void): void;
    sendToAsync(target: string, command: string, message: any): Promise<any>;
    sendToIfExists(target: string, command: string, message: any): Promise<any>;
    getForeignStateAsync(id: string): Promise<State | null | undefined>;
    setForeignStateAsync(id: string, state: any): Promise<void>;
    terminate(reason?: string): void;
  }
}

declare module '@iobroker/adapter-core' {
  export class Adapter extends ioBroker.Adapter {
    constructor(options: ioBroker.AdapterOptions);
  }

  export function getAbsoluteInstanceDataDir(adapter: ioBroker.Adapter | string): string;
}

declare const require: {
  main?: unknown;
};
declare const module: {
  exports: unknown;
};
