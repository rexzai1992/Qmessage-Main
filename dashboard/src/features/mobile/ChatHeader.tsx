import React from 'react';
import { ArrowLeft, User, Users } from 'lucide-react';

type ChatHeaderProps = {
    title: string;
    subtitle?: React.ReactNode;
    isGroup?: boolean;
    showBack?: boolean;
    onBack?: () => void;
    onOpenInfo?: () => void;
    rightSlot?: React.ReactNode;
};

export default function ChatHeader({
    title,
    subtitle,
    isGroup,
    showBack = false,
    onBack,
    onOpenInfo,
    rightSlot
}: ChatHeaderProps) {
    return (
        <header
            className="h-[60px] shrink-0 bg-[#f0f2f5] px-3 flex items-center justify-between z-10 border-b border-[#eceff1] lg:border-b-0 lg:border-l"
            style={{
                minHeight: 'calc(60px + env(safe-area-inset-top))',
                paddingTop: 'max(env(safe-area-inset-top), 0px)',
                paddingLeft: 'max(env(safe-area-inset-left), 0.75rem)',
                paddingRight: 'max(env(safe-area-inset-right), 0.75rem)'
            }}
        >
            <div className="flex items-center gap-3 min-w-0">
                {showBack && (
                    <button
                        type="button"
                        onClick={onBack}
                        className="h-9 w-9 rounded-full bg-white border border-[#eceff1] text-[#54656f] flex items-center justify-center"
                        aria-label="Back"
                    >
                        <ArrowLeft className="w-4 h-4" />
                    </button>
                )}
                <button
                    type="button"
                    className="w-10 h-10 rounded-full bg-white flex items-center justify-center overflow-hidden border border-[#eceff1] shadow-sm shrink-0"
                    onClick={onOpenInfo}
                    aria-label="Open contact details"
                >
                    {isGroup ? (
                        <Users className="text-[#54656f] w-5 h-5" />
                    ) : (
                        <User className="text-[#54656f] w-5 h-5" />
                    )}
                </button>
                <button
                    type="button"
                    className="text-left min-w-0"
                    onClick={onOpenInfo}
                >
                    <h2 className="font-bold text-[15px] leading-tight text-[#111b21] truncate">{title}</h2>
                    {subtitle && (
                        <p className="text-[11px] text-[#54656f] truncate">{subtitle}</p>
                    )}
                </button>
            </div>
            {rightSlot && <div className="flex items-center gap-2 text-[#54656f]">{rightSlot}</div>}
        </header>
    );
}
