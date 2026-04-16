import React from 'react';

type ChatBubbleProps = {
    fromMe: boolean;
    failed?: boolean;
    senderName?: string | null;
    senderColor?: string;
    timestampLabel?: string;
    statusIcon?: React.ReactNode;
    children: React.ReactNode;
    footerSlot?: React.ReactNode;
};

function ChatBubble({
    fromMe,
    failed = false,
    senderName,
    senderColor = '#6b7280',
    timestampLabel,
    statusIcon,
    children,
    footerSlot
}: ChatBubbleProps) {
    const toneClass = fromMe
        ? failed
            ? 'bg-[#fee2e2] border border-[#fecaca] text-[#7f1d1d] rounded-tr-none'
            : 'bg-[#d9fdd3] text-[#111b21] rounded-tr-none'
        : 'bg-white text-[#111b21] rounded-tl-none';
    const hasMeta = Boolean(timestampLabel || statusIcon);
    const bubbleMetaPaddingClass = hasMeta ? 'pr-14 pb-4' : '';

    return (
        <div className={`w-full flex ${fromMe ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[92%] sm:max-w-[85%] flex flex-col">
                <div
                    className={`px-3 py-1.5 rounded-xl text-[14px] shadow-[0_1px_0.5px_rgba(0,0,0,0.1)] relative mb-1 tracking-tight ${toneClass} ${bubbleMetaPaddingClass}`}
                >
                    {children}
                    {footerSlot}
                    {hasMeta && (
                        <div className="absolute right-2 bottom-2 flex items-center gap-1 leading-none">
                            {timestampLabel && (
                                <span className={`text-[10px] ${fromMe ? 'text-[#667781]' : 'text-[#7b8b97]'}`}>
                                    {timestampLabel}
                                </span>
                            )}
                            {statusIcon}
                        </div>
                    )}
                </div>
                {senderName && (
                    <div className={`flex items-center gap-1 px-1 ${fromMe ? 'justify-end' : 'justify-start'}`}>
                        <span className="text-[10px] font-bold truncate max-w-[120px]" style={{ color: senderColor }}>
                            {senderName}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}

ChatBubble.displayName = 'ChatBubble';

export default React.memo(ChatBubble);
