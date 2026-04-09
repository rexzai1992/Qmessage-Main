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

export default function ContactListItem({
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
    return (
        <button
            type="button"
            onClick={onClick}
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
                <div className="flex items-center justify-between mt-0.5 gap-2">
                    <div className="flex-1 min-w-0 flex items-center gap-1.5">
                        <p className="truncate text-[13px] text-[#54656f] font-medium leading-tight flex-1 min-w-0">{preview}</p>
                        {primaryTag && (
                            <span
                                className="max-w-[84px] truncate px-1.5 py-0.5 rounded-full bg-[#e8f5f1] border border-[#d1eee6] text-[9px] font-bold text-[#0f766e] uppercase tracking-wide"
                                title={primaryTag}
                            >
                                {primaryTag}
                            </span>
                        )}
                        {extraTagCount > 0 && (
                            <span className="text-[9px] font-bold text-[#6b7280]">+{extraTagCount}</span>
                        )}
                    </div>
                    <div className="ml-2 flex items-center gap-1.5 shrink-0">
                        {badgeCount > 0 && (
                            <span className="px-1.5 py-0.5 rounded-full bg-[#00a884] text-white text-[10px] font-black leading-4">
                                {badgeCount}
                            </span>
                        )}
                        {assignee}
                    </div>
                </div>
            </div>
        </button>
    );
}

