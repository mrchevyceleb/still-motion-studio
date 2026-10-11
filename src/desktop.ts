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
