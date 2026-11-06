/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
  readonly VITE_PACTORA_API_KEY?: string;
  readonly VITE_PACTORA_APPROVER_ID?: string;
  readonly VITE_PACTORA_APPROVAL_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
