export interface UpdateState {
  status: 'idle' | 'checking' | 'auth-required' | 'signing-in' | 'downloading' | 'ready' | 'installing' | 'current' | 'disabled' | 'error';
  currentVersion: string;
  version?: string;
  progress?: number;
  deviceCode?: string;
  message: string;
}
declare global {
  interface Window {
    stillDesktop?: {
      pickFolder: () => Promise<string | null>;
      openExternal: (url: string) => Promise<void>;
      meshyKey: { get: () => Promise<string | null>; set: (key: string) => Promise<void>; clear: () => Promise<void> };
      setTheme: (theme: 'light' | 'dark') => void;
      updates: {
        state: () => Promise<UpdateState>;
        check: () => Promise<UpdateState>;
        connect: () => Promise<UpdateState>;
        install: () => Promise<UpdateState>;
        onState: (callback: (state: UpdateState) => void) => () => void;
        onOpen: (callback: () => void) => () => void;
      };
    };
  }
}
