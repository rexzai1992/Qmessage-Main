import React from 'react';
import { Search, Users } from 'lucide-react';
import { getInitials, textColor, withHexAlpha } from '../chat/utils';
import {
    WorkspaceEmptyState,
    WorkspacePage,
    WorkspacePanel,
    WorkspaceSectionHeader
} from '../ui/workspacePrimitives';

type ContactsViewProps = {
    contactsList: any[];
    isMobileView?: boolean;
    teamUsersLoading: boolean;
    teamUsers: any[];
    contactsSearchQuery: string;
    onContactsSearchChange: (value: string) => void;
    assigningContactId: string | null;
    onToggleAssignMenu: (contactId: string) => void;
    onOpenChat: (contactId: string) => void;
};

export default function ContactsView({
    contactsList,
    isMobileView = false,
    teamUsersLoading,
    teamUsers,
    contactsSearchQuery,
    onContactsSearchChange,
    assigningContactId,
    onToggleAssignMenu,
    onOpenChat
}: ContactsViewProps) {
    return (
        <WorkspacePage isMobileView={isMobileView}>
            <WorkspacePanel className="p-4 sm:p-5 lg:p-6">
                <WorkspaceSectionHeader
                    eyebrow="Contact Operations"
                    title="Saved Contacts"
                    description="New contacts are auto-saved when messages are received or sent."
                    rightSlot={
                        <div className="qm-toolbar-right">
                            <div className="qm-chip">
                                {teamUsersLoading ? (
                                    <span className="inline-block h-2.5 w-20 animate-pulse rounded bg-[#dbe6f4]" />
                                ) : (
                                    `${teamUsers.length} staff available`
                                )}
                            </div>
                            <div className="flex min-w-[250px] items-center rounded-[14px] border border-[var(--qm-border)] bg-[#f4f8ff] px-3 py-2 transition-all focus-within:border-[var(--qm-border-strong)] focus-within:bg-white">
                                <Search className="mr-2 h-4 w-4 text-[var(--qm-text-soft)]" />
                                <input
                                    type="text"
                                    placeholder="Search contact, phone or tag"
                                    value={contactsSearchQuery}
                                    onChange={(e) => onContactsSearchChange(e.target.value)}
                                    className="w-full border-none bg-transparent text-sm font-semibold text-[var(--qm-text)] placeholder:text-[var(--qm-text-soft)] focus:outline-none"
                                />
                            </div>
                        </div>
                    }
                />
            </WorkspacePanel>

            <WorkspacePanel className="min-h-0 flex-1 overflow-hidden">
                {contactsList.length === 0 ? (
                    <div className="h-full p-5">
                        <WorkspaceEmptyState
                            title="No saved contacts yet"
                            description="Contacts will appear here automatically once conversations start in Team Inbox."
                            icon={<Users className="h-10 w-10" />}
                        />
                    </div>
                ) : (
                    <div className="h-full overflow-y-auto custom-scrollbar p-3 sm:p-4">
                        <div className="qm-table-shell hidden md:block">
                            <table>
                                <thead>
                                    <tr>
                                        <th>Contact</th>
                                        <th>Tags</th>
                                        <th>Messages</th>
                                        <th>Assignee</th>
                                        <th>Last Inbound</th>
                                        <th>Action</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {contactsList.map((row) => (
                                        <tr key={row.id}>
                                            <td className="min-w-0">
                                                <div className="truncate font-bold text-[var(--qm-text)]">{row.name}</div>
                                                <div className="mt-0.5 text-xs font-bold text-[var(--qm-brand)]">{row.phone}</div>
                                            </td>
                                            <td className="min-w-0">
                                                {row.tags.length === 0 ? (
                                                    <span className="text-xs text-[var(--qm-text-soft)]">-</span>
                                                ) : (
                                                    <div className="flex flex-wrap gap-1">
                                                        {row.tags.slice(0, 3).map((tag: string) => (
                                                            <span key={tag} className="qm-pill qm-pill-neutral">
                                                                {tag}
                                                            </span>
                                                        ))}
                                                        {row.tags.length > 3 ? (
                                                            <span className="text-xs font-bold text-[var(--qm-text-soft)]">+{row.tags.length - 3}</span>
                                                        ) : null}
                                                    </div>
                                                )}
                                            </td>
                                            <td>
                                                <span className="font-bold text-[var(--qm-text)]">{row.totalMessages}</span>
                                            </td>
                                            <td className="min-w-0">
                                                <button
                                                    type="button"
                                                    onClick={() => onToggleAssignMenu(row.id)}
                                                    disabled={assigningContactId === row.id}
                                                    className="inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold transition-all hover:opacity-85 disabled:opacity-60"
                                                    style={{
                                                        backgroundColor: row.assigneeName
                                                            ? withHexAlpha(row.assigneeColor, '20', '#f4f7fb')
                                                            : '#f4f7fb',
                                                        borderColor: row.assigneeName
                                                            ? withHexAlpha(row.assigneeColor, '66', '#d5dde9')
                                                            : '#d9e3ef',
                                                        color: row.assigneeName
                                                            ? textColor(row.assigneeColor, '#334155')
                                                            : '#6b7e93'
                                                    }}
                                                >
                                                    <span>{getInitials(row.assigneeName || 'Unassigned')}</span>
                                                    <span className="truncate">{row.assigneeName || 'Unassigned'}</span>
                                                </button>
                                            </td>
                                            <td>
                                                <span className="text-xs font-semibold text-[var(--qm-text-muted)]">
                                                    {row.lastInboundAt ? new Date(row.lastInboundAt).toLocaleString() : '-'}
                                                </span>
                                            </td>
                                            <td>
                                                <button
                                                    type="button"
                                                    onClick={() => onOpenChat(row.id)}
                                                    className="qm-btn qm-btn-primary h-8 px-3 text-[10px]"
                                                >
                                                    Open Chat
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="grid gap-2.5 md:hidden">
                            {contactsList.map((row) => (
                                <div key={`mobile-${row.id}`} className="qm-workspace-panel-muted p-3">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <div className="truncate text-sm font-bold text-[var(--qm-text)]">{row.name}</div>
                                            <div className="mt-0.5 text-xs font-bold text-[var(--qm-brand)]">{row.phone}</div>
                                        </div>
                                        <span className="text-xs font-black text-[var(--qm-text)]">{row.totalMessages} msgs</span>
                                    </div>

                                    <div className="mt-2 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                                        {row.tags.length === 0 ? (
                                            <span className="shrink-0 text-[10px] font-semibold text-[var(--qm-text-soft)]">No tag</span>
                                        ) : (
                                            <>
                                                <span className="qm-pill qm-pill-neutral max-w-[90px] shrink-0 truncate">
                                                    {row.tags[0]}
                                                </span>
                                                {row.tags.length > 1 ? (
                                                    <span className="shrink-0 text-[9px] font-bold text-[var(--qm-text-soft)]">+{row.tags.length - 1}</span>
                                                ) : null}
                                            </>
                                        )}

                                        <button
                                            type="button"
                                            onClick={() => onToggleAssignMenu(row.id)}
                                            disabled={assigningContactId === row.id}
                                            className="inline-flex max-w-[45%] min-w-0 shrink items-center gap-1 rounded-full border px-2.5 py-1 text-[10px] font-bold transition-all hover:opacity-85 disabled:opacity-60"
                                            style={{
                                                backgroundColor: row.assigneeName
                                                    ? withHexAlpha(row.assigneeColor, '20', '#f4f7fb')
                                                    : '#f4f7fb',
                                                borderColor: row.assigneeName
                                                    ? withHexAlpha(row.assigneeColor, '66', '#d5dde9')
                                                    : '#d9e3ef',
                                                color: row.assigneeName
                                                    ? textColor(row.assigneeColor, '#334155')
                                                    : '#6b7e93'
                                            }}
                                        >
                                            <span>{getInitials(row.assigneeName || 'Unassigned')}</span>
                                            <span className="truncate">{row.assigneeName || 'Unassigned'}</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => onOpenChat(row.id)}
                                            className="qm-btn qm-btn-primary ml-auto h-8 shrink-0 px-3 text-[10px]"
                                        >
                                            Open
                                        </button>
                                    </div>

                                    <div className="mt-2 text-xs text-[var(--qm-text-muted)]">
                                        Last inbound: {row.lastInboundAt ? new Date(row.lastInboundAt).toLocaleString() : '-'}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </WorkspacePanel>
        </WorkspacePage>
    );
}
