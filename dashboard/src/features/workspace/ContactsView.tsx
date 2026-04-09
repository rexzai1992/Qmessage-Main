import React from 'react';
import { Search, Users } from 'lucide-react';
import { getInitials, textColor, withHexAlpha } from '../chat/utils';

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
        <div className="h-screen pt-[64px] lg:pt-[72px] pb-[76px] lg:pb-0 bg-[#f8f9fa] text-[#111b21] font-sans">
            <div className={`h-full flex flex-col p-3 sm:p-4 lg:p-6 gap-3 lg:gap-4 ${isMobileView ? 'overflow-y-auto custom-scrollbar' : 'overflow-hidden'}`}>
                <div className={isMobileView ? 'px-1 py-1' : 'bg-white border border-[#eceff1] rounded-2xl lg:rounded-3xl p-4 lg:p-5 shadow-[0_10px_30px_rgba(0,0,0,0.05)]'}>
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div>
                            <h2 className="text-xl lg:text-2xl font-black text-[#111b21]">Saved Contacts</h2>
                            <p className="text-sm text-[#54656f] mt-1">
                                New contacts are auto-saved when messages are received or sent.
                            </p>
                            <p className="text-[11px] text-[#8696a0] mt-1">
                                {teamUsersLoading ? (
                                    <span className="inline-block animate-pulse h-3 w-32 rounded bg-[#eef2f5] align-middle" />
                                ) : (
                                    `${teamUsers.length} staff available for assignment`
                                )}
                            </p>
                        </div>
                        <div className="w-full md:w-[360px] bg-[#f0f2f5] rounded-xl flex items-center px-4 py-2.5 focus-within:bg-white focus-within:ring-1 focus-within:ring-[#00a884]/20 transition-all">
                            <Search className="w-4 h-4 text-[#54656f] mr-3" />
                            <input
                                type="text"
                                placeholder="Search contact, phone or tag"
                                value={contactsSearchQuery}
                                onChange={(e) => onContactsSearchChange(e.target.value)}
                                className="bg-transparent border-none text-[14px] w-full focus:outline-none placeholder:text-[#54656f]"
                            />
                        </div>
                    </div>
                </div>

                <div className={isMobileView ? 'pb-2' : 'flex-1 min-h-0 bg-white border border-[#eceff1] rounded-2xl lg:rounded-3xl shadow-[0_10px_30px_rgba(0,0,0,0.05)] overflow-hidden'}>
                    {contactsList.length === 0 ? (
                        <div className="h-full flex flex-col items-center justify-center text-center px-6">
                            <Users className="w-12 h-12 text-[#aebac1] mb-3" />
                            <p className="text-[#111b21] font-bold">No saved contacts</p>
                            <p className="text-sm text-[#8696a0] mt-1">
                                Contacts will appear here automatically when conversations happen.
                            </p>
                        </div>
                    ) : (
                        <div className="h-full overflow-y-auto custom-scrollbar">
                            <div className="hidden md:block">
                                <div className="grid grid-cols-[minmax(260px,1.5fr)_minmax(180px,1fr)_120px_140px_190px_120px] sticky top-0 z-10 bg-[#f8f9fa] border-b border-[#eceff1] text-[10px] font-black uppercase tracking-widest text-[#54656f]">
                                    <div className="px-4 py-3">Contact</div>
                                    <div className="px-4 py-3">Tags</div>
                                    <div className="px-4 py-3">Messages</div>
                                    <div className="px-4 py-3">Assignee</div>
                                    <div className="px-4 py-3">Last Inbound</div>
                                    <div className="px-4 py-3">Action</div>
                                </div>
                                {contactsList.map((row) => (
                                    <div key={row.id} className="grid grid-cols-[minmax(260px,1.5fr)_minmax(180px,1fr)_120px_140px_190px_120px] border-b border-[#f0f2f5] hover:bg-[#fcfdfd] transition-colors">
                                        <div className="px-4 py-3 min-w-0">
                                            <div className="font-bold text-[#111b21] truncate">{row.name}</div>
                                            <div className="text-[12px] text-[#00a884] font-bold mt-0.5">{row.phone}</div>
                                        </div>
                                        <div className="px-4 py-3 min-w-0">
                                            {row.tags.length === 0 ? (
                                                <span className="text-[12px] text-[#9ca3af]">-</span>
                                            ) : (
                                                <div className="flex flex-wrap gap-1">
                                                    {row.tags.slice(0, 3).map((tag: string) => (
                                                        <span key={tag} className="px-2 py-0.5 rounded-full bg-[#f0f2f5] border border-[#eceff1] text-[10px] font-bold text-[#54656f]">
                                                            {tag}
                                                        </span>
                                                    ))}
                                                    {row.tags.length > 3 && (
                                                        <span className="text-[11px] text-[#8696a0] font-bold">+{row.tags.length - 3}</span>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                        <div className="px-4 py-3 text-[13px] font-bold text-[#111b21]">{row.totalMessages}</div>
                                        <div className="px-4 py-3 min-w-0">
                                            <button
                                                type="button"
                                                onClick={() => onToggleAssignMenu(row.id)}
                                                disabled={assigningContactId === row.id}
                                                className="inline-flex max-w-full items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold hover:opacity-85 transition-all disabled:opacity-60"
                                                style={{
                                                    backgroundColor: row.assigneeName
                                                        ? withHexAlpha(row.assigneeColor, '20', '#f3f4f6')
                                                        : '#f8f9fa',
                                                    borderColor: row.assigneeName
                                                        ? withHexAlpha(row.assigneeColor, '66', '#d1d5db')
                                                        : '#eceff1',
                                                    color: row.assigneeName
                                                        ? textColor(row.assigneeColor, '#374151')
                                                        : '#9ca3af'
                                                }}
                                            >
                                                <span>{getInitials(row.assigneeName || 'Unassigned')}</span>
                                                <span className="truncate">{row.assigneeName || 'Unassigned'}</span>
                                            </button>
                                        </div>
                                        <div className="px-4 py-3 text-[12px] text-[#54656f] font-medium">
                                            {row.lastInboundAt ? new Date(row.lastInboundAt).toLocaleString() : '-'}
                                        </div>
                                        <div className="px-4 py-3">
                                            <button
                                                onClick={() => onOpenChat(row.id)}
                                                className="px-3 py-1.5 rounded-lg bg-[#00a884] text-white text-[10px] font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                                            >
                                                Open Chat
                                            </button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <div className="md:hidden p-3 space-y-2">
                                {contactsList.map((row) => (
                                    <div key={`mobile-${row.id}`} className="px-1 py-3 space-y-2 border-b border-[#eceff1]">
                                        <div className="flex items-start justify-between gap-3">
                                            <div className="min-w-0">
                                                <div className="font-bold text-[#111b21] truncate">{row.name}</div>
                                                <div className="text-[12px] text-[#00a884] font-bold mt-0.5">{row.phone}</div>
                                            </div>
                                            <div className="text-[11px] font-bold text-[#111b21]">{row.totalMessages} msgs</div>
                                        </div>
                                        <div className="flex flex-wrap gap-1 min-h-[20px]">
                                            {row.tags.length === 0 ? (
                                                <span className="text-[11px] text-[#9ca3af]">No tags</span>
                                            ) : (
                                                row.tags.slice(0, 4).map((tag: string) => (
                                                    <span key={`${row.id}-${tag}`} className="px-2 py-0.5 rounded-full bg-[#f0f2f5] border border-[#eceff1] text-[10px] font-bold text-[#54656f]">
                                                        {tag}
                                                    </span>
                                                ))
                                            )}
                                        </div>
                                        <div className="flex items-center justify-between gap-2">
                                            <button
                                                type="button"
                                                onClick={() => onToggleAssignMenu(row.id)}
                                                disabled={assigningContactId === row.id}
                                                className="inline-flex max-w-[62%] items-center gap-1 px-2 py-1 rounded-full border text-[10px] font-bold hover:opacity-85 transition-all disabled:opacity-60"
                                                style={{
                                                    backgroundColor: row.assigneeName
                                                        ? withHexAlpha(row.assigneeColor, '20', '#f3f4f6')
                                                        : '#f8f9fa',
                                                    borderColor: row.assigneeName
                                                        ? withHexAlpha(row.assigneeColor, '66', '#d1d5db')
                                                        : '#eceff1',
                                                    color: row.assigneeName
                                                        ? textColor(row.assigneeColor, '#374151')
                                                        : '#9ca3af'
                                                }}
                                            >
                                                <span>{getInitials(row.assigneeName || 'Unassigned')}</span>
                                                <span className="truncate">{row.assigneeName || 'Unassigned'}</span>
                                            </button>
                                            <button
                                                onClick={() => onOpenChat(row.id)}
                                                className="px-3 py-2 rounded-xl bg-[#00a884] text-white text-[10px] font-bold uppercase tracking-wider hover:bg-[#008f6f] transition-all"
                                            >
                                                Open Chat
                                            </button>
                                        </div>
                                        <div className="text-[11px] text-[#54656f]">
                                            Last inbound: {row.lastInboundAt ? new Date(row.lastInboundAt).toLocaleString() : '-'}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
