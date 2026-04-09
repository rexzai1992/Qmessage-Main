import React from 'react';

type MessageInputBarProps = {
    children: React.ReactNode;
};

export default function MessageInputBar({ children }: MessageInputBarProps) {
    return (
        <footer
            className="shrink-0 border-t border-[#e3e8ec] bg-[#f0f2f5] px-2.5 sm:px-3 py-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]"
            role="region"
            aria-label="Message composer"
        >
            {children}
        </footer>
    );
}

