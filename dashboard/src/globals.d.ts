declare const __QMESSAGE_BUILD_ID__: string;

interface ImportMetaEnv {
    readonly VITE_META_APP_ID?: string;
    readonly VITE_META_GRAPH_VERSION?: string;
    readonly VITE_META_WA_EMBEDDED_SIGNUP_V4_CONFIGURATION_ID?: string;
    readonly VITE_META_WA_EXISTING_APP_CONFIGURATION_ID?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}

interface Window {
    FB?: {
        init: (config: Record<string, unknown>) => void;
        login: (callback: (response: any) => void, options?: Record<string, unknown>) => void;
    };
    fbAsyncInit?: () => void;
}
