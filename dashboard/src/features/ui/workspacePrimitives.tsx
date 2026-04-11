import React from 'react';
import { AlertTriangle, CircleCheck, Info } from 'lucide-react';

type WorkspacePageProps = {
    children: React.ReactNode;
    isMobileView?: boolean;
    className?: string;
};

type WorkspacePanelProps = {
    children: React.ReactNode;
    className?: string;
};

type WorkspaceSectionHeaderProps = {
    eyebrow?: string;
    title: string;
    description?: string;
    rightSlot?: React.ReactNode;
};

type WorkspaceNoticeProps = {
    tone?: 'success' | 'warning' | 'error' | 'info';
    children: React.ReactNode;
    className?: string;
};

type WorkspaceEmptyStateProps = {
    title: string;
    description: string;
    icon?: React.ReactNode;
    action?: React.ReactNode;
    className?: string;
};

const joinClassNames = (...items: Array<string | false | null | undefined>): string =>
    items.filter(Boolean).join(' ');

export function WorkspacePage({
    children,
    isMobileView = false,
    className
}: WorkspacePageProps) {
    return (
        <div className={joinClassNames('qm-workspace-page qm-app-gradient font-sans', className)}>
            <div className={joinClassNames('qm-workspace-body', isMobileView ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden')}>
                <div className="qm-workspace-stack">{children}</div>
            </div>
        </div>
    );
}

export function WorkspacePanel({ children, className }: WorkspacePanelProps) {
    return <section className={joinClassNames('qm-workspace-panel', className)}>{children}</section>;
}

export function WorkspaceSectionHeader({
    eyebrow,
    title,
    description,
    rightSlot
}: WorkspaceSectionHeaderProps) {
    return (
        <div className="qm-toolbar">
            <div className="qm-toolbar-left min-w-0">
                <div className="min-w-0">
                    {eyebrow ? <p className="qm-eyebrow">{eyebrow}</p> : null}
                    <h2 className="qm-section-title mt-1 truncate">{title}</h2>
                    {description ? <p className="qm-section-copy mt-2">{description}</p> : null}
                </div>
            </div>
            {rightSlot ? <div className="qm-toolbar-right">{rightSlot}</div> : null}
        </div>
    );
}

export function WorkspaceNotice({
    tone = 'info',
    children,
    className
}: WorkspaceNoticeProps) {
    const toneClass = tone === 'success'
        ? 'qm-status-success'
        : tone === 'warning'
            ? 'qm-status-warning'
            : tone === 'error'
                ? 'qm-status-error'
                : 'qm-status-warning';

    const icon = tone === 'success'
        ? <CircleCheck className="h-4 w-4 shrink-0" />
        : tone === 'error'
            ? <AlertTriangle className="h-4 w-4 shrink-0" />
            : <Info className="h-4 w-4 shrink-0" />;

    return (
        <div className={joinClassNames('qm-status flex items-start gap-2', toneClass, className)}>
            {icon}
            <span>{children}</span>
        </div>
    );
}

export function WorkspaceEmptyState({
    title,
    description,
    icon,
    action,
    className
}: WorkspaceEmptyStateProps) {
    return (
        <div className={joinClassNames('qm-empty-state', className)}>
            {icon ? <div className="mb-3 flex justify-center text-[var(--qm-text-soft)]">{icon}</div> : null}
            <p className="text-sm font-extrabold text-[var(--qm-text)]">{title}</p>
            <p className="mx-auto mt-2 max-w-lg text-sm text-[var(--qm-text-muted)]">{description}</p>
            {action ? <div className="mt-4">{action}</div> : null}
        </div>
    );
}
