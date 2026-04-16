import React from 'react';
import { User, Users } from 'lucide-react';

type ContactListItemProps = {
    id: string;
    name: string;
    preview: string;
    timestampLabel: string;
    isSelected: boolean;
    isGroup: boolean;
    phoneLabel?: string;
    badgeCount?: number;
    primaryTag?: string | null;
    extraTagCount?: number;
    assignee?: React.ReactNode;
    onClick: () => void;
};

function ContactListItem({
    id,
    name,
    preview,
    timestampLabel,
    isSelected,
    isGroup,
    phoneLabel,
    badgeCount = 0,
    primaryTag,
    extraTagCount = 0,
    assignee,
    onClick
}: ContactListItemProps) {
    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onClick();
    }, [onClick]);

    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onClick}
            onKeyDown={handleKeyDown}
            className={`w-full flex items-start px-3 py-2.5 text-left cursor-pointer hover:bg-[#f5f6f6] transition-colors border-b border-[#fcfdfd] ${
                isSelected ? 'bg-[#f0f2f5]' : ''
            }`}
        >
            <div className="w-11 h-11 rounded-full bg-[#f0f2f5] mr-3 flex-shrink-0 flex items-center justify-center border border-[#eceff1]">
                {isGroup ? (
                    <Users className="text-[#54656f] w-5 h-5" />
                ) : (
                    <User className="text-[#54656f] w-5 h-5" />
                )}
            </div>
            <div className="flex-1 min-w-0 pb-2">
                <div className="flex justify-between items-baseline mb-0.5">
                    <h3 className="font-bold text-[15px] truncate pr-2 text-[#111b21]">{name}</h3>
                    <span className="text-[11px] font-medium text-[#54656f] shrink-0">{timestampLabel}</span>
                </div>
                {phoneLabel && <div className="text-[11px] text-[#00a884] font-bold leading-none mb-1">{phoneLabel}</div>}
                <p className="truncate text-[13px] text-[#54656f] font-medium leading-tight mt-0.5">{preview}</p>
                <div className="mt-1.5 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                    {primaryTag && (
                        <span
                            className="max-w-[88px] shrink-0 truncate px-1.5 py-0.5 rounded-full bg-[#e8f5f1] border border-[#d1eee6] text-[9px] font-bold text-[#0f766e] uppercase tracking-wide"
                            title={primaryTag}
                        >
                            {primaryTag}
                        </span>
                    )}
                    {extraTagCount > 0 && (
                        <span className="shrink-0 text-[9px] font-bold text-[#6b7280]">+{extraTagCount}</span>
                    )}
                    {assignee && (
                        <span className="shrink-0">{assignee}</span>
                    )}
                    <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded-full bg-[#edf2f7] border border-[#dbe4ee] text-[9px] font-black uppercase tracking-wide text-[#475569]">
                        Open {badgeCount}
                    </span>
                </div>
            </div>
        </div>
    );
}

ContactListItem.displayName = 'ContactListItem';

export default React.memo(ContactListItem);
