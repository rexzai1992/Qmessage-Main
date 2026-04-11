import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import {
    WorkspaceNotice,
    WorkspacePage,
    WorkspacePanel,
    WorkspaceSectionHeader
} from '../ui/workspacePrimitives';

type AiSettingsPayload = {
    enabled: boolean;
    model: string;
    systemPrompt: string;
    temperature: number;
    maxTokens: number;
    memoryEnabled: boolean;
    memoryMessages: number;
    hasApiKey: boolean;
    apiKeyHint: string;
    updatedAt?: string;
};

type ChatbotsViewProps = {
    profileId: string | null;
    sessionToken: string | null;
    apiBaseUrl: string;
};

const MODEL_OPTIONS = [
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini (fast)' },
    { value: 'gpt-4.1-mini', label: 'gpt-4.1-mini (balanced)' },
    { value: 'gpt-4.1', label: 'gpt-4.1 (best quality)' }
];

const DEFAULT_SETTINGS: AiSettingsPayload = {
    enabled: false,
    model: MODEL_OPTIONS[0].value,
    systemPrompt: 'You are a concise, helpful WhatsApp business assistant.',
    temperature: 0.4,
    maxTokens: 512,
    memoryEnabled: true,
    memoryMessages: 16,
    hasApiKey: false,
    apiKeyHint: '',
    updatedAt: ''
};

function formatSavedTime(value?: string): string {
    if (!value) return '';
    const ts = new Date(value).getTime();
    if (Number.isNaN(ts)) return '';
    return new Date(ts).toLocaleString();
}

export default function ChatbotsView({
    profileId,
    sessionToken,
    apiBaseUrl
}: ChatbotsViewProps) {
    const [settings, setSettings] = useState<AiSettingsPayload>(DEFAULT_SETTINGS);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [settingsError, setSettingsError] = useState<string | null>(null);
    const [settingsNotice, setSettingsNotice] = useState<string | null>(null);

    const canUseApi = useMemo(() => {
        return Boolean(profileId && sessionToken);
    }, [profileId, sessionToken]);

    const loadSettings = useCallback(async () => {
        if (!profileId || !sessionToken) return;
        setLoading(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const params = new URLSearchParams({ profileId });
            const res = await fetch(`${apiBaseUrl}/api/company/ai/settings?${params.toString()}`, {
                headers: {
                    authorization: `Bearer ${sessionToken}`
                }
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to load AI settings');
            }
            const incoming: AiSettingsPayload = {
                ...DEFAULT_SETTINGS,
                ...payload.data
            };
            setSettings(incoming);
            setApiKeyInput('');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to load AI settings');
        } finally {
            setLoading(false);
        }
    }, [apiBaseUrl, profileId, sessionToken]);

    useEffect(() => {
        loadSettings();
    }, [loadSettings]);

    const saveSettings = useCallback(async (clearApiKey: boolean) => {
        if (!profileId || !sessionToken) return;
        setSaving(true);
        setSettingsError(null);
        setSettingsNotice(null);
        try {
            const body: Record<string, unknown> = {
                profileId,
                enabled: settings.enabled,
                model: settings.model,
                systemPrompt: settings.systemPrompt,
                temperature: settings.temperature,
                maxTokens: settings.maxTokens,
                memoryEnabled: settings.memoryEnabled,
                memoryMessages: settings.memoryMessages
            };
            if (clearApiKey) {
                body.clearApiKey = true;
            } else if (apiKeyInput.trim()) {
                body.apiKey = apiKeyInput.trim();
            }

            const res = await fetch(`${apiBaseUrl}/api/company/ai/settings`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${sessionToken}`,
                    'content-type': 'application/json'
                },
                body: JSON.stringify(body)
            });
            const payload = await res.json().catch(() => null);
            if (!res.ok || !payload?.success || !payload?.data) {
                throw new Error(payload?.error || 'Failed to save AI settings');
            }

            setSettings({
                ...DEFAULT_SETTINGS,
                ...payload.data
            });
            setApiKeyInput('');
            setSettingsNotice(clearApiKey ? 'API key removed.' : 'AI settings saved.');
        } catch (error: any) {
            setSettingsError(error?.message || 'Failed to save AI settings');
        } finally {
            setSaving(false);
        }
    }, [apiBaseUrl, apiKeyInput, profileId, sessionToken, settings]);

    return (
        <WorkspacePage>
            <WorkspacePanel className="mx-auto w-full max-w-[920px] p-4 sm:p-5 lg:p-6">
                <WorkspaceSectionHeader
                    eyebrow="AI Assistant"
                    title="Chatbot Intelligence Settings"
                    description="Configure model behavior, API key management, and memory controls for WhatsApp response quality."
                    rightSlot={
                        <button
                            type="button"
                            onClick={loadSettings}
                            disabled={loading || !canUseApi}
                            className="qm-btn qm-btn-secondary h-10 px-3"
                        >
                            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                            Refresh
                        </button>
                    }
                />

                <div className="mt-5 qm-section-rhythm">
                    {!canUseApi ? (
                        <WorkspaceNotice tone="warning">Select an active profile and sign in to configure AI.</WorkspaceNotice>
                    ) : null}
                    {settingsError ? <WorkspaceNotice tone="error">{settingsError}</WorkspaceNotice> : null}
                    {settingsNotice ? <WorkspaceNotice tone="success">{settingsNotice}</WorkspaceNotice> : null}

                    <div className="qm-card-soft p-4">
                        <label className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-sm font-bold text-[var(--qm-text)]">Enable AI assistant</p>
                                <p className="text-xs text-[var(--qm-text-muted)]">
                                    Auto-reply when no workflow is triggered, and use AI generation manually.
                                </p>
                            </div>
                            <input
                                type="checkbox"
                                checked={settings.enabled}
                                onChange={(e) => setSettings(prev => ({ ...prev, enabled: e.target.checked }))}
                                disabled={!canUseApi}
                                className="h-4 w-4 accent-[var(--qm-brand)]"
                            />
                        </label>
                    </div>

                    <div>
                        <label className="qm-label mb-2">API Key</label>
                        <div className="relative">
                            <KeyRound className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--qm-text-soft)]" />
                            <input
                                type="password"
                                value={apiKeyInput}
                                onChange={(e) => setApiKeyInput(e.target.value)}
                                disabled={!canUseApi}
                                placeholder={settings.hasApiKey ? 'Leave blank to keep existing key' : 'Paste OpenAI API key'}
                                className="qm-input pl-9"
                            />
                        </div>
                        <div className="mt-2 flex items-center justify-between gap-2">
                            <span className="text-xs text-[var(--qm-text-muted)]">
                                {settings.hasApiKey ? `Saved: ${settings.apiKeyHint}` : 'No API key saved yet'}
                            </span>
                            <button
                                type="button"
                                onClick={() => saveSettings(true)}
                                disabled={!canUseApi || saving || !settings.hasApiKey}
                                className="qm-btn qm-btn-danger h-8 px-3 text-[10px]"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                Remove
                            </button>
                        </div>
                    </div>

                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                        <div className="sm:col-span-1">
                            <label className="qm-label mb-2">AI Model</label>
                            <select
                                value={settings.model}
                                onChange={(e) => setSettings(prev => ({ ...prev, model: e.target.value }))}
                                disabled={!canUseApi}
                                className="qm-select"
                            >
                                {MODEL_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="sm:col-span-1">
                            <label className="qm-label mb-2">Temperature</label>
                            <input
                                type="number"
                                min={0}
                                max={2}
                                step={0.1}
                                value={settings.temperature}
                                onChange={(e) => setSettings(prev => ({ ...prev, temperature: Number(e.target.value) }))}
                                disabled={!canUseApi}
                                className="qm-input"
                            />
                        </div>

                        <div className="sm:col-span-1">
                            <label className="qm-label mb-2">Max Tokens</label>
                            <input
                                type="number"
                                min={64}
                                max={4096}
                                step={1}
                                value={settings.maxTokens}
                                onChange={(e) => setSettings(prev => ({ ...prev, maxTokens: Number(e.target.value) }))}
                                disabled={!canUseApi}
                                className="qm-input"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="qm-label mb-2">System Prompt</label>
                        <textarea
                            rows={6}
                            value={settings.systemPrompt}
                            onChange={(e) => setSettings(prev => ({ ...prev, systemPrompt: e.target.value }))}
                            disabled={!canUseApi}
                            className="qm-textarea"
                        />
                    </div>

                    <div className="qm-card-soft p-4">
                        <label className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-sm font-bold text-[var(--qm-text)]">Conversation memory</p>
                                <p className="text-xs text-[var(--qm-text-muted)]">Include previous messages for better response context.</p>
                            </div>
                            <input
                                type="checkbox"
                                checked={settings.memoryEnabled}
                                onChange={(e) => setSettings(prev => ({ ...prev, memoryEnabled: e.target.checked }))}
                                disabled={!canUseApi}
                                className="h-4 w-4 accent-[var(--qm-brand)]"
                            />
                        </label>
                        <div className="mt-3">
                            <label className="qm-label mb-2">Memory Messages</label>
                            <input
                                type="number"
                                min={0}
                                max={80}
                                step={1}
                                value={settings.memoryMessages}
                                onChange={(e) => setSettings(prev => ({ ...prev, memoryMessages: Number(e.target.value) }))}
                                disabled={!canUseApi || !settings.memoryEnabled}
                                className="qm-input"
                            />
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--qm-border)] pt-4">
                        <div className="text-xs text-[var(--qm-text-soft)]">
                            {settings.updatedAt ? `Last saved: ${formatSavedTime(settings.updatedAt)}` : ''}
                        </div>
                        <button
                            type="button"
                            onClick={() => saveSettings(false)}
                            disabled={!canUseApi || saving}
                            className="qm-btn qm-btn-primary h-10 px-4"
                        >
                            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save Settings
                        </button>
                    </div>
                </div>
            </WorkspacePanel>
        </WorkspacePage>
    );
}
