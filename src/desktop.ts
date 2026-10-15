export interface UpdateState {
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'current' | 'disabled' | 'error';
  currentVersion: string;
  version?: string;
  progress?: number;
  message: string;
}
declare global {
  interface Window {
    stillDesktop?: {
      pickFolder: () => Promise<string | null>;
      setTheme: (theme: 'light' | 'dark') => void;
      updates: {
        state: () => Promise<UpdateState>;
        check: () => Promise<UpdateState>;
        install: () => Promise<UpdateState>;
        onState: (callback: (state: UpdateState) => void) => () => void;
        onOpen: (callback: () => void) => () => void;
      };
    };
  }
}
