import React, { Suspense } from 'react';
import { GitBranch, Save, Workflow } from 'lucide-react';

type WorkflowEditorMode = 'visual' | 'json';

type ChatflowViewProps = {
    open: boolean;
    selectedWorkflowId: string | null;
    workflows: any[];
    workflowDrafts: Record<string, string>;
    workflowEditorMode: WorkflowEditorMode;
    setWorkflowEditorMode: (mode: WorkflowEditorMode) => void;
    setWorkflows: React.Dispatch<React.SetStateAction<any[]>>;
    setWorkflowDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
    setSelectedWorkflowId: (id: string | null) => void;
    onSaveWorkflows: (updatedWorkflows: any[], draftOverrides?: Record<string, string>) => void;
    onBackToAutomations: () => void;
    buildBuilderFromActions: (actions: any[], workflowId: string) => any;
    buildActionsFromBuilder: (flow: any) => { actions: any[] };
    FlowCanvasComponent: React.ComponentType<any>;
    workflowTagOptions: string[];
    workflowVariableOptions: string[];
    teamUsers: any[];
    workflowTriggerOptions: Array<{ id: string; name?: string }>;
    workflowTemplateOptions: any[];
};

export default function ChatflowView({
    open,
    selectedWorkflowId,
    workflows,
    workflowDrafts,
    workflowEditorMode,
    setWorkflowEditorMode,
    setWorkflows,
    setWorkflowDrafts,
    setSelectedWorkflowId,
    onSaveWorkflows,
    onBackToAutomations,
    buildBuilderFromActions,
    buildActionsFromBuilder,
    FlowCanvasComponent,
    workflowTagOptions,
    workflowVariableOptions,
    teamUsers,
    workflowTriggerOptions,
    workflowTemplateOptions
}: ChatflowViewProps) {
    const flowFallbackCacheRef = React.useRef<Record<string, any>>({});
    const latestWorkflowsRef = React.useRef(workflows);
    const latestWorkflowDraftsRef = React.useRef(workflowDrafts);
    const flowSaveHandlerRef = React.useRef<(() => any) | null>(null);

    React.useEffect(() => {
        latestWorkflowsRef.current = workflows;
    }, [workflows]);

    React.useEffect(() => {
        latestWorkflowDraftsRef.current = workflowDrafts;
    }, [workflowDrafts]);

    const getWorkflowFlow = React.useCallback((wf: any) => {
        if (wf?.builder && Array.isArray(wf.builder.nodes)) {
            flowFallbackCacheRef.current[wf.id] = wf.builder;
            return wf.builder;
        }
        const cached = flowFallbackCacheRef.current[wf.id];
        if (cached && Array.isArray(cached.nodes)) return cached;
        const built = buildBuilderFromActions(Array.isArray(wf?.actions) ? wf.actions : [], wf.id);
        flowFallbackCacheRef.current[wf.id] = built;
        return built;
    }, [buildBuilderFromActions]);

    const syncVisualFlowToDrafts = React.useCallback((workflowId: string, nextFlow: any) => {
        const { actions } = buildActionsFromBuilder(nextFlow);
        flowFallbackCacheRef.current[workflowId] = nextFlow;
        const nextWorkflows = latestWorkflowsRef.current.map((item) =>
            item.id === workflowId ? { ...item, actions, builder: nextFlow } : item
        );
        const nextDrafts = {
            ...latestWorkflowDraftsRef.current,
            [workflowId]: JSON.stringify(actions, null, 2)
        };
        latestWorkflowsRef.current = nextWorkflows;
        latestWorkflowDraftsRef.current = nextDrafts;
        setWorkflows(nextWorkflows);
        setWorkflowDrafts(nextDrafts);
        return { nextWorkflows, nextDrafts };
    }, [buildActionsFromBuilder, setWorkflowDrafts, setWorkflows]);

    const registerFlowSaveHandler = React.useCallback((handler: (() => any) | null) => {
        flowSaveHandlerRef.current = handler;
    }, []);

    const handleSaveEverything = React.useCallback(() => {
        let nextWorkflows = latestWorkflowsRef.current;
        let nextDrafts = latestWorkflowDraftsRef.current;

        if (workflowEditorMode === 'visual' && selectedWorkflowId) {
            const getCurrentFlow = flowSaveHandlerRef.current;
            const nextFlow = getCurrentFlow ? getCurrentFlow() : null;
            if (nextFlow) {
                const synced = syncVisualFlowToDrafts(selectedWorkflowId, nextFlow);
                nextWorkflows = synced.nextWorkflows;
                nextDrafts = synced.nextDrafts;
            }
        }

        onSaveWorkflows(nextWorkflows, nextDrafts);
    }, [onSaveWorkflows, selectedWorkflowId, syncVisualFlowToDrafts, workflowEditorMode]);

    if (!open) return null;

    return (
        <div className="fixed inset-0 z-[150] flex flex-col qm-app-gradient">
            <header className="h-[72px] border-b border-[var(--qm-border)] bg-white/90 px-6 backdrop-blur-md flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-[var(--qm-border)] bg-[var(--qm-brand-soft)]">
                        <Workflow className="h-5 w-5 text-[var(--qm-brand)]" />
                    </div>
                    <h1 className="text-xl font-extrabold text-[var(--qm-text)]">WABA Workflow Builder</h1>
                </div>
                <div className="flex items-center gap-4">
                    <button
                        onClick={onBackToAutomations}
                        className="qm-btn qm-btn-secondary h-10 px-4"
                    >
                        Back to Automations
                    </button>
                    <button
                        onClick={handleSaveEverything}
                        className="qm-btn qm-btn-primary h-10 px-5"
                    >
                        <Save className="w-4 h-4" /> Save Everything
                    </button>
                </div>
            </header>

            <div className="flex-1 overflow-hidden">
                {selectedWorkflowId ? (
                    <div className="h-full flex flex-col p-5 lg:p-8 gap-6 overflow-y-auto custom-scrollbar">
                        {(() => {
                            const wf = workflows.find(w => w.id === selectedWorkflowId);
                            if (!wf) {
                                return (
                                    <div className="flex-1 flex flex-col items-center justify-center text-[var(--qm-text-soft)] gap-4">
                                        <GitBranch className="w-12 h-12" />
                                        <p className="text-sm font-bold">Workflow not found</p>
                                        <button
                                            onClick={onBackToAutomations}
                                            className="qm-btn qm-btn-secondary h-10 px-4"
                                        >
                                            Back to Automations
                                        </button>
                                    </div>
                                );
                            }
                            return (
                                <>
                                    <div className="qm-card p-4 flex items-center justify-between flex-wrap gap-3">
                                        <div className="flex flex-col">
                                            <span className="text-[10px] font-black uppercase tracking-widest text-[var(--qm-text-soft)]">Editing Workflow</span>
                                            <span className="text-sm font-bold text-[var(--qm-text)]">
                                                {(typeof wf?.name === 'string' && wf.name.trim()) || 'Untitled workflow'}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3 flex-wrap">
                                        <button
                                            onClick={() => setWorkflowEditorMode('visual')}
                                            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${workflowEditorMode === 'visual'
                                                ? 'bg-[#e8f9f3] border-[#b9e7d5] text-[var(--qm-brand)]'
                                                : 'bg-white border-[var(--qm-border)] text-[var(--qm-text-muted)] hover:border-[#90d8c0]'
                                                }`}
                                        >
                                            Visual Builder
                                        </button>
                                        <button
                                            onClick={() => setWorkflowEditorMode('json')}
                                            className={`px-4 py-2 rounded-xl text-xs font-bold border transition-all ${workflowEditorMode === 'json'
                                                ? 'bg-[#e8f9f3] border-[#b9e7d5] text-[var(--qm-brand)]'
                                                : 'bg-white border-[var(--qm-border)] text-[var(--qm-text-muted)] hover:border-[#90d8c0]'
                                                }`}
                                        >
                                            JSON Actions
                                        </button>
                                        <span className="text-[11px] text-[var(--qm-text-soft)]">
                                            Visual builder supports send message, ask question (save variable), confirm attributes, question choices, list, condition, CTA URL, simulate payment, template send, add tags, assign staff, and trigger workflow.
                                        </span>
                                    </div>
                                    {workflowEditorMode === 'visual' ? (
                                        <div className="qm-card overflow-hidden min-h-[560px] h-[70vh]">
                                            <Suspense fallback={
                                                <div className="h-full p-6 animate-pulse space-y-4 bg-[#f7fbff]">
                                                    <div className="qm-loading-block h-8 w-48 rounded-xl" />
                                                    <div className="qm-loading-block h-20 rounded-2xl" />
                                                    <div className="qm-loading-block h-20 rounded-2xl" />
                                                    <div className="qm-loading-block h-[280px] rounded-2xl" />
                                                </div>
                                            }>
                                                <FlowCanvasComponent
                                                    flow={getWorkflowFlow(wf)}
                                                    tagOptions={workflowTagOptions}
                                                    variableOptions={workflowVariableOptions}
                                                    staffOptions={teamUsers}
                                                    workflowOptions={workflowTriggerOptions.map((option) => ({
                                                        ...option,
                                                        isCurrent: option.id === wf.id
                                                    }))}
                                                    templateOptions={workflowTemplateOptions}
                                                    registerSaveHandler={registerFlowSaveHandler}
                                                    onSave={(nextFlow: any) => {
                                                        syncVisualFlowToDrafts(wf.id, nextFlow);
                                                    }}
                                                />
                                            </Suspense>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-2">
                                            <label className="text-xs font-bold text-[var(--qm-text-muted)] uppercase tracking-wider">Actions (JSON)</label>
                                            <textarea
                                                className="qm-textarea h-64 bg-[#f8f9fc] font-mono text-xs"
                                                value={workflowDrafts[wf.id] || JSON.stringify(wf.actions || [], null, 2)}
                                                onChange={(e) => {
                                                    const next = e.target.value;
                                                    setWorkflowDrafts(prev => ({ ...prev, [wf.id]: next }));
                                                }}
                                            />
                                            <p className="text-[11px] text-[var(--qm-text-soft)]">
                                                Examples:
                                                {' '}
                                                <code className="font-mono">[{`{ "type": "send_text", "text": "Hello!" }`}]</code>
                                                {' '}
                                                <code className="font-mono">[{`{ "type": "ask_question", "question": "Your name?", "save_as": "customer_name" }`}]</code>
                                                {' '}
                                                <code className="font-mono">[{`{ "type": "confirm_attributes", "fields": ["customer_name"] }`}]</code>
                                            </p>
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                ) : (
                    <div className="h-full flex flex-col items-center justify-center gap-4 text-[var(--qm-text-soft)]">
                        <GitBranch className="h-14 w-14" />
                        <p className="text-sm font-bold">No workflow selected</p>
                        <button
                            onClick={() => {
                                const id = `wf-${Date.now()}`;
                                const actions = [{ type: 'send_text', text: 'Hello! How can we help you?' }];
                                const newWf = {
                                    id,
                                    name: '',
                                    trigger_keyword: '',
                                    run_on_new_chat: false,
                                    enabled: false,
                                    actions,
                                    builder: buildBuilderFromActions(actions, id)
                                };
                                setWorkflows(prev => [...prev, newWf]);
                                setWorkflowDrafts(prev => ({
                                    ...prev,
                                    [id]: JSON.stringify(actions, null, 2)
                                }));
                                setSelectedWorkflowId(id);
                            }}
                            className="qm-btn qm-btn-primary h-10 px-4"
                        >
                            Create Workflow
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
