declare module 'node:fs/promises' {
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  export function readFile(path: string, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string, encoding: string): Promise<void>;
}

declare module 'node:path' {
  const path: {
    join: (...parts: string[]) => string;
  };
  export default path;
}

declare namespace NodeJS {
  interface Timeout {}
}
